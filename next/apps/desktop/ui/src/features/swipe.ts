/**
 * Swipe review: what the board did since you last looked, one card at a time, full screen.
 *
 * Owner, 2026-11-01: "review what have been done that day, and what new issues are created ... like
 * tinder. I should be able to comment ... after I am done ... an agent ... triggered with my comments.
 * I should also be able to record voice ... heavily gamified, with fullscreen."
 *
 * Nothing touches GitHub until the end card's Send. Until then every swipe undoes with Z, and a
 * closed deck resumes where it stopped. Send writes only what means a change (a note, a reopen, a
 * drop, a rush), then one agent terminal opens with your words.
 *
 *   → good    ← redo / drop    ↑ love / rush    ↓ skip
 *   C note    V voice    Z undo    O open on GitHub    F fullscreen    M sound    Esc pause
 *
 * The score rewards judging, not speed: a combo is a run of cards you decided, and a skip breaks it.
 */
import { errorText } from "../errors";
import "./swipe.css";

export type Kind = "done" | "new" | "dropped";
export type Move = "right" | "left" | "up" | "down";
export type ReviewCard = {
  number: number;
  title: string;
  url: string;
  kind: Kind;
  apps: string[];
  workflow: boolean;
  priority: number;
  labels: string[];
  summary: string;
  why: string;
  ask: string;
  points: string[];
  minutes: number | null;
  who: string;
  at: string | null;
  pictures: string[];
};
export type Profile = {
  xp: number;
  streak: number;
  last_day: string | null;
  last_at: string | null;
  best_combo: number;
  sessions: number;
  badges: string[];
};
export type ReviewDeck = {
  since: string;
  until: string;
  repo: string;
  cards: ReviewCard[];
  profile: Profile;
  moves: Record<Kind, Record<Move, string>>;
};
export type Verdict = { number: number; kind: Kind; move: Move; note: string; voice: boolean; priority: number };
export type SendBody = { since: string; until: string; verdicts: Verdict[]; xp: number; best_combo: number; badges: string[] };
/** One card as he judged it in a sent review. `now` is where the issue stands today: open, closed, dropped. */
export type PastVerdict = {
  number: number; title: string; url: string; apps: string[]; kind: Kind; move: Move; label: string;
  note: string; voice: boolean; did: string[]; error: string; now: "open" | "closed" | "dropped" | null;
};
export type PastReview = { id: string; since: string | null; until: string | null; xp: number; brief: string | null; agent: string | null; verdicts: PastVerdict[] };
export type ReviewHistory = { reviews: PastReview[]; repo: string };
export type SendResult = {
  /** The review's id in history; null when history could not be written. */
  id: string | null;
  applied: { number: number; label: string; act: string | null; note: string; did: string[] }[];
  errors: { number: number; error: string; note: string }[];
  brief: string | null;
  prompt: string;
  profile: Profile;
};
export type SwipeApi = {
  deck(hours: number | null): Promise<ReviewDeck>;
  voice(audio: string, mime: string): Promise<{ text: string; path: string }>;
  send(body: SendBody): Promise<SendResult>;
  picture(path: string): Promise<string>;
  history(): Promise<ReviewHistory>;
  /** Ties the agent session that took a review's brief to that review. */
  agent(id: string, session: string): Promise<unknown>;
};
export type SwipeEvents = {
  api: SwipeApi;
  appIcon(app: string): string | null;
  appName(app: string): string;
  openUrl(url: string): void;
  /** Open a visible agent terminal and type the prompt. Its session id, or null. */
  launchAgent(prompt: string): Promise<string | null>;
  showSession(id: string): boolean;
  fullscreen(on: boolean): Promise<boolean>;
  onClose(): void;
};

/* ------------------------------------------------------------ the score: a pure fold over verdicts */

export const BADGES: Record<string, { icon: string; name: string; text: string }> = {
  "first-swipe": { icon: "✦", name: "First swipe", text: "Judged your first card" },
  voice: { icon: "🎙", name: "Voice of the boss", text: "Left a spoken note" },
  "combo-10": { icon: "🔥", name: "On fire", text: "10 decisions in a row" },
  "combo-25": { icon: "☄", name: "Unstoppable", text: "25 decisions in a row" },
  boss: { icon: "👑", name: "Boss slayer", text: "Judged a P0 card" },
  critic: { icon: "✍", name: "Critic", text: "5 notes in one review" },
  cleared: { icon: "🏆", name: "Deck cleared", text: "Judged every card in the deck" },
  "night-owl": { icon: "🦉", name: "Night owl", text: "Reviewed after 23:00" },
  "early-bird": { icon: "🌅", name: "Early bird", text: "Reviewed before 08:00" },
};
const TITLES = ["Rookie", "Scout", "Sharp Eye", "Critic", "Taste Maker", "Studio Boss", "Legend", "Mythic"];
export const level = (xp: number): { n: number; title: string; from: number; to: number } => {
  const n = Math.floor(Math.sqrt(Math.max(0, xp) / 60)) + 1;
  return { n, title: TITLES[Math.min(n - 1, TITLES.length - 1)], from: 60 * (n - 1) ** 2, to: 60 * n ** 2 };
};

export type Score = { xp: number; combo: number; best: number; gains: number[]; badges: string[] };
export function score(verdicts: Verdict[], deckSize: number, hour = new Date().getHours()): Score {
  let xp = 0, combo = 0, best = 0;
  const gains: number[] = [];
  for (const v of verdicts) {
    let gain = 0;
    if (v.move === "down") combo = 0;
    else {
      combo += 1;
      const weight = v.priority === 0 ? 3 : v.priority === 1 ? 2 : 1;
      gain = Math.round(10 * weight * Math.min(3, 1 + Math.floor(combo / 5) * 0.5));
    }
    if (v.note) gain += v.voice ? 40 : 15;
    best = Math.max(best, combo);
    xp += gain;
    gains.push(gain);
  }
  const badges: string[] = [];
  if (verdicts.some((v) => v.move !== "down")) badges.push("first-swipe");
  if (verdicts.some((v) => v.voice)) badges.push("voice");
  if (best >= 10) badges.push("combo-10");
  if (best >= 25) badges.push("combo-25");
  if (verdicts.some((v) => v.priority === 0 && v.move !== "down")) badges.push("boss");
  if (verdicts.filter((v) => v.note).length >= 5) badges.push("critic");
  if (deckSize > 0 && verdicts.length >= deckSize && verdicts.some((v) => v.move !== "down")) badges.push("cleared");
  if (verdicts.length && (hour >= 23 || hour < 5)) badges.push("night-owl");
  if (verdicts.length && hour >= 5 && hour < 8) badges.push("early-bird");
  return { xp, combo, best, gains, badges };
}

/* ------------------------------------------------------------ small helpers */

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};
const btn = (cls: string, text: string, title = ""): HTMLButtonElement => {
  const el = h("button", cls, text);
  el.type = "button";
  if (title) {
    el.title = title;
    el.setAttribute("aria-label", title);
  }
  return el;
};
const ago = (iso: string | null): string => {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
};
const clock = (iso: string): string => {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
  return days === 0 ? `today ${time}` : days === 1 ? `yesterday ${time}` : `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
};
const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private storage: the deck still works, it only forgets */
    }
  },
};
const KIND_WORD: Record<Kind, string> = { done: "Shipped", new: "New", dropped: "Dropped" };
const MOVE_KEY: Record<Move, string> = { left: "←", down: "↓", up: "↑", right: "→" };
const reducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/* ------------------------------------------------------------ sound: synthesized, no assets */

function makeSound(): { play(name: "right" | "left" | "up" | "down" | "combo" | "level" | "badge" | "undo" | "tick", n?: number): void; muted: boolean } {
  let ctx: AudioContext | null = null;
  const self = {
    muted: store.get("panel.swipe.muted", false),
    play(name: string, n = 0): void {
      if (self.muted) return;
      try {
        ctx ??= new AudioContext();
        const tone = (freq: number, at: number, dur: number, type: OscillatorType = "sine", vol = 0.12, slide = 0): void => {
          const osc = ctx!.createOscillator();
          const gain = ctx!.createGain();
          const t = ctx!.currentTime + at;
          osc.type = type;
          osc.frequency.setValueAtTime(freq, t);
          if (slide) osc.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          osc.connect(gain).connect(ctx!.destination);
          osc.start(t);
          osc.stop(t + dur + 0.02);
        };
        if (name === "right") { tone(523, 0, 0.12, "triangle"); tone(784, 0.07, 0.18, "triangle"); }
        else if (name === "left") tone(330, 0, 0.22, "sawtooth", 0.06, 0.55);
        else if (name === "up") { tone(659, 0, 0.1, "triangle"); tone(988, 0.06, 0.1, "triangle"); tone(1319, 0.12, 0.22, "triangle"); }
        else if (name === "down") tone(220, 0, 0.12, "sine", 0.08, 0.8);
        else if (name === "undo") tone(440, 0, 0.12, "sine", 0.08, 0.7);
        else if (name === "tick") tone(1200, 0, 0.03, "square", 0.03);
        else if (name === "combo") tone(660 * 2 ** (Math.min(n, 24) / 12), 0, 0.14, "square", 0.05);
        else if (name === "badge") [784, 988, 1175, 1568].forEach((f, i) => tone(f, i * 0.07, 0.25, "triangle", 0.09));
        else if (name === "level") [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.3, "square", 0.06));
      } catch {
        /* no audio device: the game is silent, not broken */
      }
    },
  };
  return self;
}

/* ------------------------------------------------------------ the screen */

type Phase = "loading" | "start" | "play" | "end" | "sent" | "error" | "history";
const HISTORY_ALL = "panel.swipe.history.all";
/** A verdict that asked for something: words, or a move that changes the issue. Mirrors MOVES in review.py. */
const acted = (v: { note: string; kind: Kind; move: Move }): boolean =>
  Boolean(v.note) || v.move === "left" || (v.move === "up" && v.kind === "new");
const NOW_WORD = { open: "Now open", closed: "Now closed", dropped: "Now dropped" } as const;
type Draft = { saved: number; verdicts: Verdict[] };
const DRAFT_DAYS = 3;
const DRAFT = "panel.swipe.draft";
const FILTER = "panel.swipe.filter";

export function openSwipe(events: SwipeEvents): { close(): void } {
  const { api } = events;
  const sound = makeSound();
  const root = h("div", "sw-root");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Swipe review");
  root.tabIndex = -1;
  const bg = h("div", "sw-bg");
  bg.append(h("i", "sw-orb sw-orb-a"), h("i", "sw-orb sw-orb-b"), h("i", "sw-orb sw-orb-c"));
  const stage = h("div", "sw-stage");
  const fx = h("div", "sw-fx");
  const toasts = h("div", "sw-toasts");
  toasts.setAttribute("role", "status");
  fx.append(toasts);
  root.append(bg, stage, fx);
  document.body.append(root);

  let phase: Phase = "loading";
  let deck: ReviewDeck | null = null;
  let range: number | null = null;
  let failure = "";
  let filter = store.get<Record<string, boolean>>(FILTER, { done: true, new: true, dropped: true, workflow: true });
  let cards: ReviewCard[] = [];
  let verdicts: Verdict[] = [];
  let note: { text: string; voice: boolean } | null = null;
  let recording: { stop(): void; started: number } | null = null;
  let arming = false;
  let editing = false;
  let transcribing = false;
  let sending = false;
  let sent: SendResult | null = null;
  let agent: string | null = null;
  let agentError = "";
  let fullscreen = false;
  let paused = false;
  /** True while the judged card flies off: the next card is not painted yet, so nothing may judge it. */
  let flying = false;
  /** Set by "Finish now": the end of the window he really reviewed, so the cards he left come back next time. */
  let reviewedUntil: string | null = null;
  /** The history screen: what he decided before, and the screen he came from. */
  let past: ReviewHistory | null = null;
  let pastError = "";
  let pastFrom: Phase = "start";
  let pastAll = store.get<boolean>(HISTORY_ALL, false);
  const busy = (): boolean => flying || Boolean(recording) || transcribing || arming;
  const pictures = new Map<string, Promise<string>>();

  const current = (): ReviewCard | null => cards[verdicts.length] ?? null;
  const tally = (): Score => score(verdicts, cards.length);
  const saveDraft = (): void => store.set(DRAFT, { saved: Date.now(), verdicts } satisfies Draft);
  /** The swipes of a deck you left, while its first cards are still the same ones in the same order.
   *  Not keyed on `since`: with no finished review yet, the window moves with the clock. */
  const resumed = (deal: ReviewCard[]): Verdict[] => {
    const draft = store.get<Draft | null>(DRAFT, null);
    if (!draft?.verdicts || !(Date.now() - (draft.saved ?? 0) < DRAFT_DAYS * 86_400_000)) return [];
    const kept: Verdict[] = [];
    for (const [i, v] of draft.verdicts.entries()) {
      if (deal[i]?.number !== v.number) break;
      kept.push(v);
    }
    return kept;
  };

  async function load(hours: number | null): Promise<void> {
    phase = "loading";
    paint();
    try {
      deck = await api.deck(hours);
      range = hours;
      failure = "";
      phase = "start";
    } catch (error) {
      failure = errorText(error, "the board could not be read");
      phase = "error";
    }
    paint();
  }

  function deal(): void {
    if (!deck) return;
    cards = deck.cards.filter((c) => filter[c.kind] && (filter.workflow || !c.workflow));
    verdicts = resumed(cards);
    phase = cards.length && verdicts.length >= cards.length ? "end" : "play";
    paint();
  }

  /* ---------------- moves */

  function commit(move: Move): void {
    const card = current();
    if (!card || phase !== "play" || paused) return;
    // A voice note still recording or turning into text belongs to this card: judging now would lose it
    // or post it on the next one.
    if (busy()) {
      if (!flying) toast("Finish the voice note first", "warn");
      return;
    }
    const before = tally();
    verdicts.push({ number: card.number, kind: card.kind, move, note: note?.text.trim() ?? "", voice: Boolean(note?.voice && note.text.trim()), priority: card.priority });
    note = null;
    editing = false;
    saveDraft();
    const after = tally();
    sound.play(move);
    burst(move, after.gains[after.gains.length - 1] ?? 0, after.combo);
    if (after.combo > 0 && after.combo % 5 === 0) {
      sound.play("combo", after.combo);
      toast(`Combo ×${after.combo}`, "combo");
    }
    const was = level((deck?.profile.xp ?? 0) + before.xp).n;
    const now = level((deck?.profile.xp ?? 0) + after.xp);
    if (now.n > was) {
      sound.play("level");
      toast(`Level ${now.n} · ${now.title}`, "level");
      confetti(70);
    }
    for (const id of after.badges) {
      if (!before.badges.includes(id) && !deck?.profile.badges.includes(id)) {
        window.setTimeout(() => {
          sound.play("badge");
          toast(`${BADGES[id].icon} ${BADGES[id].name}`, "badge", BADGES[id].text);
        }, 350);
      }
    }
    flying = true;
    flyOut(move, () => {
      flying = false;
      if (verdicts.length >= cards.length) {
        phase = "end";
        confetti(120);
      }
      paint();
    });
  }

  function undo(): void {
    if (!verdicts.length || (phase !== "play" && phase !== "end") || busy()) return;
    if (reviewedUntil) {
      cards = deck?.cards.filter((c) => filter[c.kind] && (filter.workflow || !c.workflow)) ?? cards;
      reviewedUntil = null;
    }
    const last = verdicts.pop()!;
    note = last.note ? { text: last.note, voice: last.voice } : null;
    editing = false;
    saveDraft();
    sound.play("undo");
    phase = "play";
    paint();
    stage.querySelector(".sw-card.is-top")?.classList.add("sw-back");
  }

  /* ---------------- voice */

  async function toggleVoice(): Promise<void> {
    if (recording) {
      recording.stop();
      return;
    }
    if (transcribing || arming || phase !== "play") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast("No microphone here", "warn", "Panel's window cannot reach a microphone.");
      return;
    }
    let stream: MediaStream;
    arming = true;
    paint();
    try {
      // macOS asks once; until he answers, the note box says so instead of looking dead.
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      toast("Microphone blocked", "warn", errorText(error, "Allow Panel in System Settings → Privacy → Microphone."));
      return;
    } finally {
      arming = false;
      paint();
    }
    if (shutDown || phase !== "play") {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (e) => { if (e.data.size) chunks.push(e.data); });
    const meter = startMeter(stream);
    const limit = window.setTimeout(() => recording?.stop(), 120_000);
    recorder.addEventListener("stop", () => {
      window.clearTimeout(limit);
      meter();
      stream.getTracks().forEach((t) => t.stop());
      recording = null;
      void transcribe(new Blob(chunks, { type: recorder.mimeType || mime || "audio/mp4" }));
    });
    recorder.start();
    recording = { stop: () => recorder.state !== "inactive" && recorder.stop(), started: Date.now() };
    note ??= { text: "", voice: true };
    sound.play("tick");
    paint();
  }

  function startMeter(stream: MediaStream): () => void {
    let frame = 0;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const draw = (): void => {
        analyser.getByteFrequencyData(data);
        const bars = root.querySelectorAll<HTMLElement>(".sw-wave i");
        bars.forEach((bar, i) => {
          const v = data[Math.floor((i / bars.length) * data.length * 0.6)] / 255;
          bar.style.transform = `scaleY(${0.12 + v * 0.88})`;
        });
        const time = root.querySelector(".sw-rec-time");
        if (time && recording) time.textContent = `${Math.floor((Date.now() - recording.started) / 1000)}s`;
        frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);
    } catch {
      /* the meter is decoration; recording goes on without it */
    }
    return () => {
      cancelAnimationFrame(frame);
      void ctx?.close();
    };
  }

  async function transcribe(blob: Blob): Promise<void> {
    transcribing = true;
    paint();
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const { text } = await api.voice(btoa(binary), blob.type);
      if (text) {
        note = { text: [note?.text.trim(), text].filter(Boolean).join(" "), voice: true };
        sound.play("badge");
      } else toast("Heard nothing", "warn", "Try again a little closer to the mic.");
    } catch (error) {
      toast("Could not transcribe", "warn", errorText(error, "whisper failed"));
    } finally {
      transcribing = false;
      if (note && !note.text.trim()) note = null;
      editing = Boolean(note);
      paint();
      if (note) focusNote();
    }
  }

  /* ---------------- send */

  async function send(): Promise<void> {
    if (!deck || sending) return;
    sending = true;
    paint();
    const s = tally();
    try {
      sent = await api.send({ since: deck.since, until: reviewedUntil ?? deck.until, verdicts, xp: s.xp, best_combo: s.best, badges: s.badges });
      store.set(DRAFT, null);
      phase = "sent";
      sound.play("level");
      confetti(140);
      if (sent.prompt) {
        try {
          agent = await events.launchAgent(sent.prompt);
          if (!agent) agentError = "The agent terminal did not open.";
          else if (sent.id) void api.agent(sent.id, agent).catch(() => undefined); // history links it; the review stands without it
        } catch (error) {
          agentError = errorText(error, "The agent terminal did not open.");
        }
      }
    } catch (error) {
      toast("Send failed", "warn", errorText(error, "GitHub did not answer. Nothing is lost: try again."));
    } finally {
      sending = false;
      paint();
    }
  }

  /* ---------------- effects */

  function toast(title: string, tone: string, text = ""): void {
    const el = h("div", `sw-toast sw-toast-${tone}`);
    el.append(h("b", "", title));
    if (text) el.append(h("span", "", text));
    toasts.append(el);
    window.setTimeout(() => el.remove(), 2600);
  }

  function burst(move: Move, gain: number, combo: number): void {
    const color = { right: "var(--sw-good)", left: "var(--sw-bad)", up: "var(--sw-star)", down: "var(--sw-skip)" }[move];
    if (gain > 0) {
      const pop = h("div", "sw-pop", `+${gain} XP`);
      if (combo >= 5) pop.append(h("small", "", ` ×${Math.min(3, 1 + Math.floor(combo / 5) * 0.5)}`));
      pop.style.color = color;
      fx.append(pop);
      window.setTimeout(() => pop.remove(), 1100);
    }
    if (reducedMotion() || move === "down") return;
    for (let i = 0; i < 22; i++) {
      const p = h("i", "sw-spark");
      const angle = (Math.PI * 2 * i) / 22 + Math.random() * 0.3;
      const reach = 120 + Math.random() * 180;
      const bias = move === "right" ? 140 : move === "left" ? -140 : 0;
      p.style.setProperty("--dx", `${Math.cos(angle) * reach + bias}px`);
      p.style.setProperty("--dy", `${Math.sin(angle) * reach + (move === "up" ? -160 : 0)}px`);
      p.style.background = color;
      fx.append(p);
      window.setTimeout(() => p.remove(), 900);
    }
  }

  function confetti(n: number): void {
    if (reducedMotion()) return;
    const colors = ["#ffd166", "#06d6a0", "#ef476f", "#7c5cff", "#4cc9f0", "#ff9f1c"];
    for (let i = 0; i < n; i++) {
      const p = h("i", "sw-confetti");
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = colors[i % colors.length];
      p.style.setProperty("--drift", `${(Math.random() - 0.5) * 300}px`);
      p.style.setProperty("--spin", `${(Math.random() - 0.5) * 1440}deg`);
      p.style.animationDelay = `${Math.random() * 0.5}s`;
      p.style.animationDuration = `${1.8 + Math.random() * 1.4}s`;
      fx.append(p);
      window.setTimeout(() => p.remove(), 4000);
    }
  }

  function flyOut(move: Move, done: () => void): void {
    const top = stage.querySelector<HTMLElement>(".sw-card.is-top");
    if (!top || reducedMotion()) return done();
    const x = move === "right" ? 1.4 : move === "left" ? -1.4 : 0;
    const y = move === "up" ? -1.3 : move === "down" ? 1.3 : 0;
    top.style.transition = "transform 280ms cubic-bezier(.3,.7,.4,1), opacity 280ms";
    top.style.transform = `translate(${x * window.innerWidth * 0.6}px, ${y * window.innerHeight * 0.7}px) rotate(${x * 24}deg)`;
    top.style.opacity = "0";
    window.setTimeout(done, 230);
  }

  /* ---------------- drag */

  function draggable(el: HTMLElement): void {
    let start: { x: number; y: number; t: number; id: number } | null = null;
    let dx = 0, dy = 0;
    const stamps = {
      right: el.querySelector<HTMLElement>(".sw-stamp-right"),
      left: el.querySelector<HTMLElement>(".sw-stamp-left"),
      up: el.querySelector<HTMLElement>(".sw-stamp-up"),
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button, a, textarea, .sw-scroll-x")) return;
      start = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
      el.setPointerCapture(e.pointerId);
      el.style.transition = "none";
    });
    el.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      dx = e.clientX - start.x;
      dy = e.clientY - start.y;
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
      const r = Math.max(0, Math.min(1, dx / 140));
      const l = Math.max(0, Math.min(1, -dx / 140));
      const u = Math.max(0, Math.min(1, -dy / 140)) * (Math.abs(dx) < 80 ? 1 : 0);
      if (stamps.right) stamps.right.style.opacity = String(r);
      if (stamps.left) stamps.left.style.opacity = String(l);
      if (stamps.up) stamps.up.style.opacity = String(u);
      root.style.setProperty("--sw-tint", dx > 30 ? "var(--sw-good)" : dx < -30 ? "var(--sw-bad)" : u > 0.3 ? "var(--sw-star)" : "transparent");
    });
    const end = (e: PointerEvent): void => {
      if (!start || e.pointerId !== start.id) return;
      const speed = Math.hypot(dx, dy) / Math.max(1, performance.now() - start.t);
      start = null;
      root.style.setProperty("--sw-tint", "transparent");
      const far = (n: number): boolean => Math.abs(n) > 130 || (Math.abs(n) > 50 && speed > 0.7);
      const move: Move | null = far(dx) && Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left")
        : far(dy) && Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? "up" : "down") : null;
      dx = dy = 0;
      if (move) return commit(move);
      el.style.transition = "transform 320ms cubic-bezier(.2,1.4,.4,1)";
      el.style.transform = "";
      Object.values(stamps).forEach((s) => s && (s.style.opacity = "0"));
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  /* ---------------- painting */

  function hud(): HTMLElement {
    const bar = h("header", "sw-hud");
    const s = tally();
    const total = (deck?.profile.xp ?? 0) + s.xp;
    const lv = level(total);
    const lvBox = h("div", "sw-level");
    lvBox.append(h("b", "sw-level-n", String(lv.n)));
    const lvText = h("div", "sw-level-text");
    lvText.append(h("span", "sw-level-title", lv.title), h("small", "", `${total.toLocaleString()} XP`));
    const xpBar = h("div", "sw-xpbar");
    const fill = h("i");
    fill.style.transform = `scaleX(${(total - lv.from) / (lv.to - lv.from)})`;
    xpBar.append(fill);
    lvText.append(xpBar);
    lvBox.append(lvText);

    const mid = h("div", "sw-progress");
    if (phase === "play" || phase === "end") {
      const done = verdicts.length;
      mid.append(h("span", "sw-progress-text", `${Math.min(done + 1, cards.length)} / ${cards.length}`));
      const track = h("div", "sw-track");
      const f = h("i");
      f.style.transform = `scaleX(${cards.length ? done / cards.length : 0})`;
      track.append(f);
      mid.append(track);
    }

    const right = h("div", "sw-hud-right");
    const streak = h("span", "sw-chip sw-streak", `🔥 ${deck?.profile.streak ?? 0}`);
    streak.title = "Days in a row you finished a review";
    right.append(streak);
    if (phase === "play") {
      const combo = h("span", `sw-chip sw-combo${s.combo >= 5 ? " is-hot" : ""}`, `×${s.combo}`);
      combo.title = "Combo: cards decided in a row. A skip breaks it.";
      const sessionXp = h("span", "sw-chip sw-xp", `+${s.xp}`);
      sessionXp.title = "XP this review";
      right.append(combo, sessionXp);
    }
    const mute = btn("sw-icon", sound.muted ? "🔇" : "🔊", sound.muted ? "Sound on (M)" : "Sound off (M)");
    mute.addEventListener("click", toggleMute);
    const full = btn("sw-icon", fullscreen ? "⤡" : "⤢", fullscreen ? "Leave fullscreen (F)" : "Fullscreen (F)");
    full.addEventListener("click", () => void toggleFullscreen());
    const close = btn("sw-icon", "✕", "Close (Esc). Your swipes are kept.");
    close.addEventListener("click", () => (phase === "play" ? pause() : shut()));
    right.append(mute, full, close);
    bar.append(lvBox, mid, right);
    return bar;
  }

  function startScreen(): HTMLElement {
    const box = h("div", "sw-start");
    box.append(h("div", "sw-kicker", "Daily review"), h("h1", "sw-hero", "Swipe the board"));
    if (!deck) return box;
    box.append(h("p", "sw-sub", `Since ${clock(deck.since)} · ${deck.cards.length} cards waiting`));
    const counts = { done: 0, new: 0, dropped: 0, workflow: 0 };
    for (const c of deck.cards) {
      counts[c.kind] += 1;
      if (c.workflow) counts.workflow += 1;
    }
    const chips = h("div", "sw-filters");
    const chip = (key: keyof typeof counts, label: string, tone: string): void => {
      const b = btn(`sw-filter ${tone}${filter[key] ? " is-on" : ""}`, "");
      b.append(h("b", "", String(counts[key])), h("span", "", label));
      b.setAttribute("aria-pressed", String(Boolean(filter[key])));
      b.addEventListener("click", () => {
        filter = { ...filter, [key]: !filter[key] };
        store.set(FILTER, filter);
        paint();
      });
      chips.append(b);
    };
    chip("done", "Shipped", "t-good");
    chip("new", "New", "t-star");
    chip("dropped", "Dropped", "t-bad");
    chip("workflow", "Workflow", "t-skip");
    box.append(chips);
    const ranges = h("div", "sw-ranges");
    for (const [hours, label] of [[null, "Since last review"], [24, "24 hours"], [72, "3 days"]] as const) {
      const b = btn(`sw-range${range === hours ? " is-on" : ""}`, label);
      b.addEventListener("click", () => void load(hours));
      ranges.append(b);
    }
    box.append(ranges);
    const size = deck.cards.filter((c) => filter[c.kind] && (filter.workflow || !c.workflow)).length;
    const resuming = resumed(deck.cards.filter((c) => filter[c.kind] && (filter.workflow || !c.workflow))).length > 0;
    const go = btn("sw-go", size ? (resuming ? `Continue · ${size} cards` : `Start · ${size} cards`) : "Nothing to review");
    go.disabled = !size;
    go.addEventListener("click", deal);
    box.append(go);
    if (deck.profile.sessions) {
      const looking = btn("sw-ghost", "What you decided before · H");
      looking.addEventListener("click", () => void openHistory());
      box.append(looking);
    }
    const quests = h("div", "sw-quests");
    quests.append(h("span", "", "Today’s quests"), h("small", "", "Clear the deck · Leave 3 notes · Build a ×10 combo"));
    box.append(quests);
    if (deck.profile.badges.length) {
      const shelf = h("div", "sw-shelf");
      for (const id of deck.profile.badges) {
        const b = BADGES[id];
        if (!b) continue;
        const el = h("span", "sw-badge", b.icon);
        el.title = `${b.name}: ${b.text}`;
        shelf.append(el);
      }
      box.append(shelf);
    }
    box.append(legend());
    return box;
  }

  function legend(): HTMLElement {
    const keys = h("div", "sw-legend");
    for (const [k, t] of [["→", "good"], ["←", "redo / drop"], ["↑", "love / rush"], ["↓", "skip"], ["C", "note"], ["V", "voice"], ["Z", "undo"], ["H", "history"], ["F", "fullscreen"]]) {
      const item = h("span");
      item.append(h("kbd", "", k), document.createTextNode(` ${t}`));
      keys.append(item);
    }
    return keys;
  }

  function cardView(card: ReviewCard, depth: number): HTMLElement {
    const el = h("article", `sw-card k-${card.kind}${depth === 0 ? " is-top" : ""}${card.priority === 0 ? " is-boss" : ""}`);
    el.style.setProperty("--depth", String(depth));
    if (depth > 0) {
      el.setAttribute("aria-hidden", "true");
      return el;
    }
    const moves = deck!.moves[card.kind];
    el.append(h("div", "sw-stamp sw-stamp-right", moves.right), h("div", "sw-stamp sw-stamp-left", moves.left),
      h("div", "sw-stamp sw-stamp-up", moves.up));
    const top = h("div", "sw-card-top");
    top.append(h("span", "sw-kind", KIND_WORD[card.kind]), h("b", `sw-p sw-p${card.priority}`, card.priority === 0 ? "P0 · BOSS" : `P${card.priority}`));
    const num = btn("sw-num", `#${card.number}`, "Open on GitHub (O)");
    num.addEventListener("click", () => events.openUrl(card.url));
    top.append(num);
    el.append(top);
    const apps = h("div", "sw-apps");
    if (card.apps.length) {
      for (const app of card.apps.slice(0, 3)) {
        const tile = h("span", "sw-app");
        const src = events.appIcon(app);
        if (src) {
          const img = h("img");
          img.src = src;
          img.alt = "";
          img.addEventListener("error", () => img.remove(), { once: true });
          tile.append(img);
        } else tile.append(h("i", "", events.appName(app).charAt(0).toUpperCase()));
        tile.append(h("span", "", events.appName(app)));
        apps.append(tile);
      }
    } else apps.append(h("span", "sw-app sw-app-ops", "Workflow"));
    el.append(apps);
    const body = h("div", "sw-card-body");
    body.append(h("h2", "sw-title", card.title));
    if (card.summary) body.append(h("p", "sw-summary", card.summary));
    if (card.pictures.length) {
      const strip = h("div", "sw-pictures sw-scroll-x");
      for (const path of card.pictures) {
        const img = h("img", "sw-picture");
        img.alt = "Picture from the issue";
        if (!pictures.has(path)) pictures.set(path, api.picture(path));
        void pictures.get(path)!.then((src) => { img.src = src; }).catch(() => img.remove());
        strip.append(img);
      }
      body.append(strip);
    }
    if (card.ask) {
      const ask = h("p", "sw-ask");
      ask.append(h("b", "", "Ask "), document.createTextNode(card.ask));
      body.append(ask);
    }
    if (card.points.length) {
      const list = h("ul", `sw-points${card.kind === "done" ? " is-proof" : ""}`);
      list.append(...card.points.map((p) => h("li", "", p)));
      body.append(h("div", "sw-label", card.kind === "done" ? "Proof" : "Done when"), list);
    }
    if (card.why) {
      const why = h("p", "sw-why");
      why.append(h("b", "", "Why "), document.createTextNode(card.why));
      body.append(why);
    }
    el.append(body);
    const foot = h("footer", "sw-card-foot");
    foot.append(h("span", "", [card.who, card.minutes ? `${card.minutes} min` : "", ago(card.at)].filter(Boolean).join(" · ")));
    if (card.labels.length) foot.append(h("span", "sw-tags", card.labels.join(" · ")));
    el.append(foot);
    return el;
  }

  function noteBox(): HTMLElement | null {
    if (!note && !recording && !transcribing && !arming) return null;
    const box = h("div", "sw-note");
    if (arming) {
      box.append(h("div", "sw-transcribing", "Waiting for the microphone… allow Panel if macOS asks"));
      return box;
    }
    if (recording) {
      const rec = h("div", "sw-rec");
      rec.append(h("i", "sw-rec-dot"), h("span", "sw-rec-time", "0s"));
      const wave = h("div", "sw-wave");
      for (let i = 0; i < 28; i++) wave.append(h("i"));
      const stop = btn("sw-rec-stop", "Stop · V", "Stop recording (V)");
      stop.addEventListener("click", () => recording?.stop());
      rec.append(wave, stop);
      box.append(rec);
      return box;
    }
    if (transcribing) {
      box.append(h("div", "sw-transcribing", "Listening back… turning your voice into words"));
      return box;
    }
    if (!editing && note) {
      // Saved: the words stay in view, out of the way of the arrow keys. A click edits them.
      const saved = btn("sw-note-saved", "", "Edit the note (C)");
      saved.append(h("span", "sw-note-saved-icon", note.voice ? "🎙" : "✎"), h("span", "sw-note-saved-text", note.text),
        h("small", "", "edit · C"));
      saved.addEventListener("click", openNote);
      box.append(saved);
      return box;
    }
    const area = h("textarea", "sw-note-input");
    area.placeholder = "What should the agent do about this? Enter saves, Esc cancels.";
    area.value = note?.text ?? "";
    area.rows = 3;
    area.addEventListener("input", () => { note = { text: area.value, voice: note?.voice ?? false }; });
    area.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        editing = false;
        if (!note?.text.trim()) note = null;
        paint();
        root.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        editing = false;
        note = null;
        paint();
        root.focus();
      }
    });
    box.append(area);
    const tip = h("div", "sw-note-tip", note?.voice ? "🎙 From your voice · +40 XP when you swipe" : "+15 XP when you swipe · the agent gets these words");
    box.append(tip);
    return box;
  }

  function focusNote(): void {
    requestAnimationFrame(() => {
      const area = root.querySelector<HTMLTextAreaElement>(".sw-note-input");
      area?.focus();
      area?.setSelectionRange(area.value.length, area.value.length);
    });
  }

  function actions(card: ReviewCard): HTMLElement {
    const bar = h("div", "sw-actions");
    const moves = deck!.moves[card.kind];
    const action = (move: Move, cls: string, icon: string): HTMLButtonElement => {
      const b = btn(`sw-act ${cls}`, "", `${moves[move]} (${MOVE_KEY[move]})`);
      b.append(h("span", "sw-act-icon", icon), h("small", "", moves[move]));
      b.addEventListener("click", () => commit(move));
      return b;
    };
    const write = btn(`sw-act sw-act-small${note ? " is-on" : ""}`, "", "Write a note (C)");
    write.append(h("span", "sw-act-icon", "✎"), h("small", "", "Note"));
    write.addEventListener("click", openNote);
    const mic = btn(`sw-act sw-act-small sw-mic${recording ? " is-rec" : ""}`, "", recording ? "Stop recording (V)" : "Speak a note (V)");
    mic.append(h("span", "sw-act-icon", "🎙"), h("small", "", recording ? "Stop" : "Voice"));
    mic.disabled = transcribing;
    mic.addEventListener("click", () => void toggleVoice());
    bar.append(write, action("left", "t-bad", card.kind === "new" ? "✕" : "↺"), action("down", "t-skip", "↓"),
      action("up", "t-star", card.kind === "new" ? "⚡" : "♥"), action("right", "t-good", "✓"), mic);
    return bar;
  }

  function openNote(): void {
    if (phase !== "play" || recording || transcribing || arming) return;
    note ??= { text: "", voice: false };
    editing = true;
    paint();
    focusNote();
  }

  function endScreen(): HTMLElement {
    const box = h("div", "sw-end");
    const s = tally();
    const counts = new Map<string, number>();
    for (const v of verdicts) {
      const label = deck!.moves[v.kind][v.move];
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    box.append(h("div", "sw-kicker", "Deck cleared"), h("h1", "sw-hero", `+${s.xp} XP`));
    const stats = h("div", "sw-endstats");
    for (const [label, n] of counts) {
      const st = h("div", "sw-endstat");
      st.append(h("b", "", String(n)), h("span", "", label));
      stats.append(st);
    }
    const best = h("div", "sw-endstat");
    best.append(h("b", "", `×${s.best}`), h("span", "", "best combo"));
    stats.append(best);
    box.append(stats);
    const fresh = s.badges.filter((b) => !deck!.profile.badges.includes(b));
    if (fresh.length) {
      const shelf = h("div", "sw-shelf sw-shelf-new");
      for (const id of fresh) {
        const el = h("div", "sw-badge-big");
        el.append(h("span", "", BADGES[id].icon), h("b", "", BADGES[id].name), h("small", "", BADGES[id].text));
        shelf.append(el);
      }
      box.append(shelf);
    }
    const notes = verdicts.filter(acted);
    if (notes.length) {
      box.append(h("div", "sw-label", `${notes.length} for the agent`));
      const list = h("ul", "sw-orders");
      for (const v of notes) {
        const c = cards.find((x) => x.number === v.number);
        const li = h("li");
        li.append(h("b", `sw-order-tag m-${v.move}`, deck!.moves[v.kind][v.move]), h("span", "", `#${v.number} ${c?.title ?? ""}`));
        if (v.note) li.append(h("em", "", `${v.voice ? "🎙 " : ""}${v.note}`));
        list.append(li);
      }
      box.append(list);
    } else box.append(h("p", "sw-sub", "No notes and no changes. Sending only records your streak."));
    const row = h("div", "sw-end-row");
    const back = btn("sw-ghost", "Undo last · Z");
    back.addEventListener("click", undo);
    const go = btn("sw-go", sending ? "Sending…" : notes.length ? "Send to agents" : "Finish");
    go.disabled = sending;
    go.addEventListener("click", () => void send());
    row.append(back, go);
    box.append(row);
    return box;
  }

  function sentScreen(): HTMLElement {
    const box = h("div", "sw-end");
    const r = sent!;
    const lv = level(r.profile.xp);
    box.append(h("div", "sw-kicker", `Level ${lv.n} · ${lv.title}`), h("h1", "sw-hero", agent ? "Agent is on it" : "Review saved"));
    const did = r.applied.flatMap((a) => a.did);
    const count = (w: string): number => did.filter((d) => d === w).length;
    const parts = [
      count("noted") && `${count("noted")} notes posted`,
      count("reopened") && `${count("reopened")} reopened`,
      count("closed") && `${count("closed")} dropped`,
      did.filter((d) => d.startsWith("P")).length && `${did.filter((d) => d.startsWith("P")).length} rushed`,
    ].filter(Boolean);
    box.append(h("p", "sw-sub", parts.length ? parts.join(" · ") : "Nothing needed changing on GitHub."));
    const stats = h("div", "sw-endstats");
    for (const [v, l] of [[`🔥 ${r.profile.streak}`, "day streak"], [r.profile.xp.toLocaleString(), "total XP"], [`×${r.profile.best_combo}`, "best combo ever"]]) {
      const st = h("div", "sw-endstat");
      st.append(h("b", "", v), h("span", "", l));
      stats.append(st);
    }
    box.append(stats);
    if (r.errors.length) {
      const err = h("div", "sw-errors");
      err.append(h("b", "", `${r.errors.length} could not be written`));
      for (const e of r.errors) err.append(h("span", "", `#${e.number}: ${e.error}${e.note ? ` · “${e.note}”` : ""}`));
      err.append(h("span", "", r.brief ? "Your words are in the agent's brief. It writes them for you." : ""));
      box.append(err);
    }
    if (agentError) box.append(h("p", "sw-errline", `${agentError} The brief is at ${r.brief}`));
    const row = h("div", "sw-end-row");
    if (agent) {
      const watch = btn("sw-go", "Watch the agent");
      watch.addEventListener("click", () => {
        const id = agent!;
        shut();
        events.showSession(id);
      });
      row.append(watch);
    }
    const looking = btn("sw-ghost", "Your decisions · H");
    looking.addEventListener("click", () => void openHistory());
    const done = btn(agent ? "sw-ghost" : "sw-go", "Close");
    done.addEventListener("click", shut);
    row.append(looking, done);
    box.append(row);
    return box;
  }

  /* ---------------- history */

  async function openHistory(): Promise<void> {
    if (phase === "history" || phase === "loading" || busy() || editing) return;
    pastFrom = phase;
    paused = false;
    phase = "history";
    pastError = "";
    paint();
    try {
      past = await api.history();
    } catch (error) {
      pastError = errorText(error, "Your past reviews could not be read.");
    }
    if (phase === "history") paint();
  }

  function closeHistory(): void {
    phase = pastFrom;
    paint();
  }

  /** One decision as a row: the verdict, the card, his words, and what came of it. A click opens the issue. */
  function pastRow(v: { number: number; title: string; url: string; kind: Kind; move: Move; label: string; note: string; voice: boolean },
    facts: { text: string; tone: string }[]): HTMLElement {
    const li = h("li", `sw-past-row${acted(v) ? "" : " is-plain"}`);
    const open = btn("sw-past-open", "", `Open #${v.number} on GitHub`);
    open.append(h("b", `sw-order-tag m-${v.move}`, v.label), h("span", "sw-past-title", `#${v.number} ${v.title}`));
    open.addEventListener("click", () => events.openUrl(v.url));
    li.append(open);
    if (v.note) li.append(h("em", "", `${v.voice ? "🎙 " : "✎ "}${v.note}`));
    if (facts.length) {
      const row = h("div", "sw-past-facts");
      for (const f of facts) row.append(h("span", `sw-fact ${f.tone}`, f.text));
      li.append(row);
    }
    return li;
  }

  function historyScreen(): HTMLElement {
    const box = h("div", "sw-end sw-history");
    box.append(h("div", "sw-kicker", "Your decisions"), h("h1", "sw-hero sw-hero-small", "What you decided"));
    const toggle = h("div", "sw-ranges");
    for (const [all, label] of [[false, "Notes and changes"], [true, "Everything"]] as const) {
      const b = btn(`sw-range${pastAll === all ? " is-on" : ""}`, label);
      b.setAttribute("aria-pressed", String(pastAll === all));
      b.addEventListener("click", () => { pastAll = all; store.set(HISTORY_ALL, all); paint(); });
      toggle.append(b);
    }
    box.append(toggle);
    const scroll = h("div", "sw-past");

    // This review, before it is sent: what he would be sending.
    const pending = verdicts.filter((v) => pastAll || acted(v));
    if ((pastFrom === "play" || pastFrom === "end") && verdicts.length) {
      const group = h("section", "sw-past-group is-pending");
      group.append(h("div", "sw-past-head", `This review · not sent yet · ${verdicts.length} judged`));
      const list = h("ul", "sw-past-list");
      for (const v of pending) {
        const c = cards.find((x) => x.number === v.number);
        list.append(pastRow({ ...v, title: c?.title ?? "", url: c?.url ?? "", label: deck!.moves[v.kind][v.move] }, []));
      }
      if (!pending.length) list.append(h("li", "sw-past-empty", "No notes or changes yet."));
      group.append(list);
      scroll.append(group);
    }

    if (pastError) scroll.append(h("p", "sw-errline", pastError));
    else if (!past) scroll.append(h("div", "sw-loading sw-loading-inline", "Reading your past reviews…"));
    else if (!past.reviews.length) scroll.append(h("p", "sw-sub", "No sent reviews yet. Finish a deck and they show up here."));
    else {
      for (const r of past.reviews) {
        const shown = r.verdicts.filter((v) => pastAll || acted(v));
        const group = h("section", "sw-past-group");
        const head = h("div", "sw-past-head");
        const asked = r.verdicts.filter(acted).length;
        const many = r.verdicts.length === 1 ? "1 card" : `${r.verdicts.length} cards`;
        head.append(h("span", "", `${clock(r.id)} · ${many} · ${asked} asked · +${r.xp} XP`));
        if (r.agent) {
          const watch = btn("sw-past-agent", "Watch the agent");
          watch.addEventListener("click", () => {
            const id = r.agent!;
            if (events.showSession(id)) shut();
            else toast("That agent session is closed", "warn", "Its work is on each issue, a click away.");
          });
          head.append(watch);
        }
        group.append(head);
        const list = h("ul", "sw-past-list");
        for (const v of shown) {
          const facts: { text: string; tone: string }[] = [];
          for (const d of v.did) if (d !== "noted") facts.push({ text: d === "reopened" ? "Reopened" : d === "closed" ? "Closed" : d, tone: "" });
          if (v.error) facts.push({ text: `Not written: ${v.error}`, tone: "is-bad" });
          if (v.now) facts.push({ text: NOW_WORD[v.now], tone: v.now === "closed" ? "is-good" : v.now === "dropped" ? "is-bad" : "is-open" });
          list.append(pastRow(v, facts));
        }
        if (!shown.length) list.append(h("li", "sw-past-empty", "Only approvals and skips. Show everything to see them."));
        group.append(list);
        scroll.append(group);
      }
    }
    box.append(scroll);
    const back = btn("sw-go", pastFrom === "play" ? "Back to the deck · Esc" : "Back · Esc");
    back.addEventListener("click", closeHistory);
    box.append(back);
    return box;
  }

  function pauseLayer(): HTMLElement {
    const layer = h("div", "sw-pause");
    const box = h("div", "sw-pause-box");
    box.append(h("h2", "", "Paused"), h("p", "", `${verdicts.length} of ${cards.length} judged. Your swipes are kept; nothing is sent yet.`));
    const resume = btn("sw-go", "Resume");
    resume.addEventListener("click", () => { paused = false; paint(); });
    const finish = btn("sw-ghost", "Finish now and send");
    finish.disabled = !verdicts.length;
    finish.addEventListener("click", () => {
      // The next review starts at the oldest card he left, so none of them slips past him.
      const left = cards.slice(verdicts.length).map((c) => c.at).filter(Boolean).sort()[0];
      reviewedUntil = left ? new Date(Date.parse(left) - 1000).toISOString() : null;
      paused = false;
      cards = cards.slice(0, verdicts.length);
      phase = "end";
      paint();
    });
    const looking = btn("sw-ghost", "Your decisions · H");
    looking.addEventListener("click", () => void openHistory());
    const leave = btn("sw-ghost", "Leave for later");
    leave.addEventListener("click", shut);
    box.append(resume, looking, finish, leave);
    layer.append(box);
    return layer;
  }

  function paint(): void {
    root.dataset.phase = phase;
    const nodes: HTMLElement[] = [hud()];
    if (phase === "loading") nodes.push(h("div", "sw-loading", "Shuffling the deck…"));
    else if (phase === "error") {
      const box = h("div", "sw-start");
      box.append(h("h1", "sw-hero", "No deck"), h("p", "sw-errline", failure));
      const again = btn("sw-go", "Try again");
      again.addEventListener("click", () => void load(range));
      box.append(again);
      nodes.push(box);
    } else if (phase === "start") nodes.push(startScreen());
    else if (phase === "end") nodes.push(endScreen());
    else if (phase === "sent") nodes.push(sentScreen());
    else if (phase === "history") nodes.push(historyScreen());
    else {
      const card = current();
      const table = h("div", "sw-table");
      const pile = h("div", "sw-pile");
      const behind = cards.slice(verdicts.length + 1, verdicts.length + 3);
      behind.reverse().forEach((c, i) => pile.append(cardView(c, behind.length - i)));
      if (card) {
        const top = cardView(card, 0);
        pile.append(top);
        draggable(top);
        if (note) top.append(h("span", "sw-note-flag", note.voice ? "🎙 note" : "✎ note"));
      }
      table.append(pile);
      const nb = noteBox();
      if (nb) table.append(nb);
      if (card) table.append(actions(card));
      nodes.push(table);
      if (paused) nodes.push(pauseLayer());
    }
    stage.replaceChildren(...nodes);
  }

  /* ---------------- keys and lifecycle */

  function toggleMute(): void {
    sound.muted = !sound.muted;
    store.set("panel.swipe.muted", sound.muted);
    paint();
  }

  async function toggleFullscreen(): Promise<void> {
    fullscreen = await events.fullscreen(!fullscreen).catch(() => fullscreen);
    paint();
  }

  function pause(): void {
    if (recording) recording.stop();
    paused = true;
    paint();
  }

  const KEYS: Record<string, Move> = { ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up", ArrowDown: "down" };
  function onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = (e.target as HTMLElement)?.tagName === "TEXTAREA";
    if (typing) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let handled = true;
    if (key === "Escape") {
      if (recording) recording.stop();
      else if (phase === "history") closeHistory();
      else if (paused) { paused = false; paint(); }
      else if (phase === "play") pause();
      else shut();
    } else if (key === "f") void toggleFullscreen();
    else if (key === "m") toggleMute();
    else if (key === "h") void openHistory();
    else if (phase === "history") handled = false;
    else if (paused) handled = false;
    else if (phase === "start" && key === "Enter") deal();
    else if (phase === "end" && key === "Enter") void send();
    else if (key === "z" || key === "Backspace") undo();
    else if (phase !== "play") handled = false;
    else if (KEYS[key]) { if (!e.repeat) commit(KEYS[key]); }
    else if (key === "c" || key === "Enter") openNote();
    else if (key === "v") void toggleVoice();
    else if (key === "o" && current()) events.openUrl(current()!.url);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  window.addEventListener("keydown", onKey, true);

  let shutDown = false;
  function shut(): void {
    if (shutDown) return;
    shutDown = true;
    recording?.stop();
    window.removeEventListener("keydown", onKey, true);
    if (fullscreen) void events.fullscreen(false).catch(() => false);
    root.classList.add("is-leaving");
    window.setTimeout(() => root.remove(), reducedMotion() ? 0 : 220);
    events.onClose();
  }

  root.focus();
  void toggleFullscreen();
  void load(null);
  return { close: shut };
}
