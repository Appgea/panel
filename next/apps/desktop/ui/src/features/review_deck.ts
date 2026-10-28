/**
 * The review deck: one batch of agent output, one piece at a time, full screen.
 *
 * Reviewing should feel like flipping through prints, not clearing an inbox. So: big media, the
 * keyboard does everything, sounds start on their own, and nothing asks you to approve. What you
 * leave alone is fine; only a change has a key. At the end the changes become one message the
 * agent can act on, sent straight into its terminal.
 *
 * A piece is seen once it is on screen here. Closing part way keeps the rest new, and notes are
 * kept as they are written: nothing is lost by leaving.
 *
 *   ← →    previous / next          Space   play / pause
 *   C      needs changes (a note)   B       before / after, for a redo
 *   F      show in Finder           Esc     close, nothing changes
 */
export type DeckItem = {
  project: string;
  path: string;
  /** The URL to load it from, versioned so a re-render is not served from cache. */
  src: string;
  /** Shown under the media and used in the feedback. */
  label: string;
  kind: "image" | "audio" | "video";
  /** A redo of something you sent back: what you asked, and the old version when it was kept. */
  before?: { note: string; src: Promise<string | null> };
};

/** How the deck ended: the notes sent (or copied) from the end card, or closed any other way. */
export type DeckEnd = "sent" | "left";

export type DeckOptions = {
  title: string;
  /** Who the summary's Send goes to, or null when no agent is open on the project. */
  agentName: string | null;
  /** Change notes already written on this batch, by path. A note is kept as soon as it is written. */
  notes: Map<string, string>;
  onNote(path: string, note: string | null): void;
  /** A piece was on screen: it is seen now. */
  onSeen(path: string): void;
  send(text: string): Promise<boolean>;
  copy(text: string): Promise<boolean>;
  /** Show this file in Finder. */
  reveal(path: string): void;
  onClose(end: DeckEnd): void;
};

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const clock = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** The feedback as the agent will read it: plain lines, file names it can find. */
export function feedbackText(items: DeckItem[], notes: Map<string, string>): string {
  const changed = items.filter((item) => notes.has(item.path));
  const lines = changed.map((item) => `- ${item.label} — ${notes.get(item.path)}`);
  const head = `I reviewed what you made. ${changed.length === 1 ? "One needs" : `${changed.length} need`} changes:`;
  const rest = items.length > changed.length ? ["The rest is fine as it is."] : [];
  return [head, ...lines, ...rest].join("\n");
}

/**
 * A waveform for a sound, drawn once from the decoded file. It is what makes a list of takes
 * readable at a glance (silence, clipping, a long pause), and it doubles as the scrubber.
 */
async function drawWave(canvas: HTMLCanvasElement, url: string): Promise<number[] | null> {
  try {
    const bytes = await (await fetch(url)).arrayBuffer();
    const context = new AudioContext();
    const audio = await context.decodeAudioData(bytes);
    void context.close();
    const data = audio.getChannelData(0);
    const bars = 140;
    const step = Math.max(1, Math.floor(data.length / bars));
    const peaks: number[] = [];
    for (let bar = 0; bar < bars; bar++) {
      let peak = 0;
      for (let at = bar * step; at < Math.min(data.length, (bar + 1) * step); at += 16) {
        peak = Math.max(peak, Math.abs(data[at]));
      }
      peaks.push(peak);
    }
    const top = Math.max(...peaks, 0.01);
    return peaks.map((peak) => peak / top);
  } catch {
    canvas.classList.add("is-flat");
    return null;
  }
}

function paintWave(canvas: HTMLCanvasElement, peaks: number[] | null, progress: number): void {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ink = canvas.getContext("2d");
  if (!ink) return;
  ink.scale(ratio, ratio);
  const style = getComputedStyle(canvas);
  const played = style.getPropertyValue("--wave-played").trim() || "#9a88ff";
  const rest = style.getPropertyValue("--wave-rest").trim() || "#3a4258";
  const bars = peaks ?? new Array(140).fill(0.12);
  const gap = 2;
  const barWidth = Math.max(1, (width - gap * (bars.length - 1)) / bars.length);
  bars.forEach((peak, index) => {
    const barHeight = Math.max(2, peak * (height - 4));
    const x = index * (barWidth + gap);
    ink.fillStyle = (index + 0.5) / bars.length <= progress ? played : rest;
    ink.beginPath();
    ink.roundRect(x, (height - barHeight) / 2, barWidth, barHeight, barWidth / 2);
    ink.fill();
  });
}

export function openReviewDeck(items: DeckItem[], start: number, options: DeckOptions): void {
  if (!items.length) return;
  document.querySelector(".rd-veil")?.remove();
  const notes = new Map(options.notes);
  let index = Math.min(Math.max(start, 0), items.length - 1);
  let summary = false;
  let noting = false;
  let player: HTMLMediaElement | null = null;
  /** The one pending step forward after a note; a second key press never adds another. */
  let advance = 0;
  /** Showing the old version of a redo instead of the new one. */
  let showingBefore = false;
  const before = document.activeElement as HTMLElement | null;

  const veil = make("div", "rd-veil");
  veil.setAttribute("role", "dialog");
  veil.setAttribute("aria-modal", "true");
  veil.setAttribute("aria-label", `Review ${options.title}`);
  veil.tabIndex = -1;

  const top = make("header", "rd-top");
  const where = make("div", "rd-where");
  const counter = make("span", "rd-count");
  const finder = make("button", "rd-btn is-small", "Finder");
  finder.type = "button";
  finder.title = "Show this file in Finder · F";
  const close = make("button", "rd-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close review");
  close.title = "Close · Esc · nothing changes";
  top.append(where, counter, finder, close);

  const stage = make("div", "rd-stage");
  const prev = make("button", "rd-nav is-prev", "‹");
  prev.type = "button";
  prev.setAttribute("aria-label", "Previous");
  const next = make("button", "rd-nav is-next", "›");
  next.type = "button";
  next.setAttribute("aria-label", "Next");
  const frame = make("div", "rd-frame");
  stage.append(prev, frame, next);

  const caption = make("div", "rd-caption");
  const asked = make("div", "rd-asked");
  const verdictBar = make("div", "rd-verdicts");
  const flip = make("button", "rd-verdict is-flip");
  flip.type = "button";
  const change = make("button", "rd-verdict is-change");
  change.type = "button";
  change.innerHTML = `<span>Needs changes</span><kbd>C</kbd>`;
  const note = make("form", "rd-note");
  const noteInput = make("input");
  noteInput.type = "text";
  noteInput.placeholder = "What should change? Enter saves · empty removes the note";
  noteInput.setAttribute("aria-label", "What should change");
  note.append(noteInput);
  note.hidden = true;
  verdictBar.append(flip, change);

  const strip = make("div", "rd-strip");
  const dock = make("footer", "rd-dock");
  dock.append(asked, caption, verdictBar, note, strip);
  veil.append(top, stage, dock);

  where.append(make("b", "", options.title));

  function stopPlayer(): void {
    player?.pause();
    player = null;
  }

  function thumb(item: DeckItem, at: number): HTMLElement {
    const tile = make("button", `rd-thumb is-${item.kind}`);
    tile.type = "button";
    tile.title = item.label;
    if (item.kind === "image") {
      const image = make("img");
      image.src = item.src;
      image.alt = "";
      image.loading = "lazy";
      tile.append(image);
    } else {
      tile.append(make("span", "rd-thumb-glyph", item.kind === "audio" ? "♪" : "▶"));
    }
    const mark = make("i", "rd-mark");
    tile.append(mark);
    tile.addEventListener("click", () => go(at));
    return tile;
  }
  strip.append(...items.map(thumb));
  strip.hidden = items.length < 2;

  function paintStrip(): void {
    [...strip.children].forEach((child, at) => {
      child.classList.toggle("is-current", !summary && at === index);
      child.classList.toggle("is-change", notes.has(items[at].path));
    });
    strip.children[index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function audioCard(url: string): HTMLElement {
    const card = make("div", "rd-audio");
    const audio = make("audio");
    audio.preload = "auto";
    audio.src = url;
    const play = make("button", "rd-play");
    play.type = "button";
    play.setAttribute("aria-label", "Play");
    const wave = make("canvas", "rd-wave");
    const time = make("span", "rd-time", "0:00");
    let peaks: number[] | null = null;
    const progress = (): number => (audio.duration ? audio.currentTime / audio.duration : 0);
    const repaint = (): void => {
      paintWave(wave, peaks, progress());
      time.textContent = `${clock(audio.currentTime)} / ${clock(audio.duration)}`;
      play.classList.toggle("is-playing", !audio.paused);
      play.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
    };
    void drawWave(wave, audio.src).then((found) => {
      peaks = found;
      repaint();
    });
    for (const name of ["timeupdate", "play", "pause", "loadedmetadata", "ended"]) {
      audio.addEventListener(name, repaint);
    }
    play.addEventListener("click", () => void (audio.paused ? audio.play() : audio.pause()));
    wave.addEventListener("click", (event) => {
      if (!audio.duration) return;
      const box = wave.getBoundingClientRect();
      audio.currentTime = ((event.clientX - box.left) / box.width) * audio.duration;
      void audio.play();
    });
    audio.addEventListener("error", () => card.classList.add("is-missing"), { once: true });
    card.append(play, wave, time, audio);
    player = audio;
    requestAnimationFrame(repaint);
    // A take is for hearing: it starts on arrival, the way the next track does.
    void audio.play().catch(() => undefined);
    return card;
  }

  function media(item: DeckItem, url: string): HTMLElement {
    if (item.kind === "image") {
      const image = make("img", "rd-image");
      image.src = url;
      image.alt = item.label;
      image.addEventListener("error", () => frame.classList.add("is-missing"), { once: true });
      return image;
    }
    if (item.kind === "video") {
      const video = make("video", "rd-video");
      video.src = url;
      video.controls = true;
      video.autoplay = true;
      player = video;
      return video;
    }
    return audioCard(url);
  }

  function paintItem(): void {
    stopPlayer();
    const item = items[index];
    counter.textContent = `${index + 1} of ${items.length}`;
    caption.textContent = showingBefore ? `${item.label} · before` : item.label;
    frame.classList.remove("is-missing");
    frame.classList.toggle("is-before", showingBefore);
    if (showingBefore && item.before) {
      frame.replaceChildren();
      const shown = index;
      void item.before.src.then((url) => {
        if (index !== shown || !showingBefore || summary || !veil.isConnected) return;
        frame.replaceChildren(url ? media(item, url) : make("div", "rd-gone", "The old version was not kept. Your note is above."));
      });
    } else {
      frame.replaceChildren(media(item, item.src));
    }
    asked.hidden = !item.before;
    if (item.before) asked.textContent = `You asked: ${item.before.note || "changes"}`;
    flip.hidden = !item.before;
    flip.innerHTML = `<span>${showingBefore ? "Show new" : "Show before"}</span><kbd>B</kbd>`;
    flip.classList.toggle("is-on", showingBefore);
    change.classList.toggle("is-on", notes.has(item.path));
    change.title = notes.get(item.path) ?? "";
    prev.disabled = index === 0;
    next.disabled = false;
    // Preload the next picture so the flip is instant.
    const after = items[index + 1];
    if (after?.kind === "image") new Image().src = after.src;
    paintStrip();
    options.onSeen(item.path);
  }

  function paintSummary(): void {
    stopPlayer();
    summary = true;
    counter.textContent = "End";
    caption.textContent = "";
    const changed = items.filter((item) => notes.has(item.path)).length;
    const box = make("div", "rd-summary");
    box.append(make("b", "rd-summary-title", changed ? `${changed} to change` : "That's everything"));
    box.append(make("p", "", changed ? "Close keeps the notes here, unsent." : "It moves under the new work in Review."));
    const text = feedbackText(items, notes);
    if (changed) box.append(make("pre", "rd-feedback", text));
    const row = make("div", "rd-summary-actions");
    const shut = make("button", changed ? "rd-btn" : "rd-btn is-primary", "Close");
    shut.type = "button";
    shut.addEventListener("click", () => finish("left"));
    row.append(shut);
    let first: HTMLButtonElement = shut;
    if (changed) {
      const send = make("button", "rd-btn is-primary", options.agentName ? `Send to ${options.agentName}` : "Copy feedback");
      send.type = "button";
      send.addEventListener("click", async () => {
        send.disabled = true;
        const ok = options.agentName ? await options.send(text) : await options.copy(text);
        send.textContent = ok ? (options.agentName ? "Sent" : "Copied") : "Could not send";
        if (ok) window.setTimeout(() => finish("sent"), 650);
        else send.disabled = false;
      });
      row.append(send);
      first = send;
    }
    window.setTimeout(() => first.focus(), 0);
    box.append(row);
    frame.classList.remove("is-missing");
    frame.classList.remove("is-before");
    frame.replaceChildren(box);
    asked.hidden = true;
    verdictBar.hidden = true;
    prev.disabled = false;
    next.disabled = true;
    paintStrip();
  }

  function go(at: number): void {
    // Moving on keeps what you typed: words are never lost to a click.
    closeNote(true);
    window.clearTimeout(advance);
    showingBefore = false;
    if (at >= items.length) {
      paintSummary();
      return;
    }
    summary = false;
    verdictBar.hidden = false;
    index = Math.max(0, at);
    paintItem();
  }

  /** A note sends this piece back; null takes that back. Kept at once, so leaving loses nothing. */
  function mark(text: string | null): void {
    const path = items[index].path;
    if (text === null) notes.delete(path);
    else notes.set(path, text);
    options.onNote(path, text);
    paintStrip();
    change.classList.toggle("is-on", text !== null);
    change.title = text ?? "";
    if (text === null) return;
    // A short beat so the mark is seen landing, then the next piece. One step, from this piece.
    const from = index;
    window.clearTimeout(advance);
    advance = window.setTimeout(() => {
      if (!veil.isConnected || summary || index !== from) return;
      go(from + 1);
    }, 220);
  }

  function openNote(): void {
    noting = true;
    verdictBar.hidden = true;
    note.hidden = false;
    noteInput.value = notes.get(items[index].path) ?? "";
    noteInput.focus();
  }

  function closeNote(save: boolean): void {
    if (!noting) return;
    noting = false;
    note.hidden = true;
    verdictBar.hidden = summary;
    veil.focus();
    if (!save) return;
    const text = noteInput.value.trim();
    // The box is the note: empty means there is none.
    if (!text && !notes.has(items[index].path)) return;
    mark(text || null);
  }

  function finish(end: DeckEnd): void {
    closeNote(true);
    window.clearTimeout(advance);
    stopPlayer();
    document.removeEventListener("keydown", onKey, true);
    veil.remove();
    before?.focus?.();
    options.onClose(end);
  }

  function toggleBefore(): void {
    if (summary || !items[index].before) return;
    showingBefore = !showingBefore;
    paintItem();
  }

  function onKey(event: KeyboardEvent): void {
    if (noting) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeNote(true);
      }
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.tagName === "BUTTON" && (event.key === "Enter" || event.key === " ") && summary) return;
    const key = event.key.toLowerCase();
    const handled = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (key === "escape") return handled(), finish("left");
    // The end card is the end: → there stays put instead of flipping back to the last piece.
    if (key === "arrowright" || key === "l") return handled(), void (summary || go(index + 1));
    if (key === "arrowleft" || key === "h") return handled(), go(summary ? items.length - 1 : index - 1);
    if (summary) return;
    if (key === " ") {
      handled();
      if (player) void (player.paused ? player.play() : player.pause());
      return;
    }
    if (key === "c" || key === "n") return handled(), openNote();
    if (key === "b") return handled(), toggleBefore();
    if (key === "f") return handled(), options.reveal(items[index].path);
  }

  note.addEventListener("submit", (event) => {
    event.preventDefault();
    closeNote(true);
  });
  flip.addEventListener("click", toggleBefore);
  change.addEventListener("click", openNote);
  prev.addEventListener("click", () => go(summary ? items.length - 1 : index - 1));
  next.addEventListener("click", () => go(index + 1));
  finder.addEventListener("click", () => options.reveal(items[Math.min(index, items.length - 1)].path));
  close.addEventListener("click", () => finish("left"));
  veil.addEventListener("click", (event) => {
    if (event.target === veil || event.target === stage) finish("left");
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(veil);
  veil.focus();
  go(index);
}
