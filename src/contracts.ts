/**
 * Shared contracts between the four modules. Each module owns one folder:
 *   src/scene/    renderer, park environment, lighting, camera, quality, loading screen, WebGL fallback
 *   src/pigeon/   one procedurally built, procedurally animated pigeon
 *   src/feeding/  bread, throw input (touch / mouse / keyboard), crumbs, flock brain, squabbles
 *   src/state/    streak + familiarity + Gerald (localStorage)   src/ui/  HUD, hint, announcer
 *   src/audio/    sound          src/net/  crumb counter client
 *
 * Changing this file changes everyone's contract, so it is owned by the integrator (main session).
 *
 * World conventions (metres, right-handed, Three.js default):
 *   - Ground is the plane y = 0.
 *   - The viewer sits on a bench at roughly (0, 1.1, 2.2) looking toward -Z, slightly down.
 *   - The flock lives roughly in x ∈ [-3.5, 3.5], z ∈ [-7, 0.6].
 *   - A real pigeon is ~0.32 m beak-to-tail and ~0.25 m tall; stay true to that scale.
 */
import type * as THREE from 'three';

/* ------------------------------------------------------------------ events */

export interface GameEvents {
  /** A crumb left the bread. Counted toward the worldwide total, eaten or not. */
  'crumb:tossed': { id: number; from: THREE.Vector3; to: THREE.Vector3; input: InputKind };
  'crumb:landed': { id: number; at: THREE.Vector3 };
  'crumb:eaten': { id: number; pigeonName: string | null; isGerald: boolean };
  'crumb:faded': { id: number };
  'pigeon:peck': { at: THREE.Vector3 };
  'pigeon:flap': { at: THREE.Vector3; strength: number };
  'pigeon:coo': { at: THREE.Vector3; isGerald: boolean };
  'pigeon:arrived': { isGerald: boolean };
  'squabble': { at: THREE.Vector3; winnerIsGerald: boolean };
  'flock:glance': Record<string, never>;
  'flock:forgiven': Record<string, never>;
  /** First crumb of a new local calendar day; state has already been committed. */
  'day:fed': { snapshot: VisitSnapshot };
  'sound:toggled': { on: boolean };
}

export type InputKind = 'touch' | 'mouse' | 'keyboard';

export interface EventBus {
  on<K extends keyof GameEvents>(type: K, fn: (payload: GameEvents[K]) => void): () => void;
  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void;
}

/* ------------------------------------------------------------------ environment */

export interface Env {
  reducedMotion: boolean;
  /** Fires if the OS setting changes while the page is open. */
  onReducedMotionChange(fn: (reduced: boolean) => void): () => void;
  /** Primary pointer is coarse (touch). Used to word the hint. */
  coarsePointer: boolean;
}

/* ------------------------------------------------------------------ scene (src/scene) */

export type QualityLevel = 'high' | 'medium' | 'low';

export interface Quality {
  level: QualityLevel;
  shadows: boolean;
  pixelRatio: number;
  /** Upper bound on live pigeons regardless of what familiarity asks for. */
  maxPigeons: number;
}

export interface SceneHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  quality: Quality;
  onQualityChange(fn: (q: Quality) => void): () => void;

  /** Screen point (CSS px, relative to canvas) to ground point, or null if it misses the ground. */
  screenToGround(x: number, y: number): THREE.Vector3 | null;
  worldToScreen(p: THREE.Vector3): { x: number; y: number; visible: boolean };

  /** Where the bread rests, in the foreground near the bottom of the screen. Throws start here. */
  breadAnchor: THREE.Vector3;
  /** A spot on the bench seat beside the viewer, for Gerald's late-stage visits. */
  benchSpot: THREE.Vector3;
  /** Walkable area for pigeons (axis-aligned on the ground, x/z). */
  walkBounds: { minX: number; maxX: number; minZ: number; maxZ: number };

  /** Ease the camera back as the flock grows. `instant` for first frame or reduced motion. */
  frameFlock(count: number, instant: boolean): void;

  /** Called every frame before render. dt in seconds (clamped), t = elapsed seconds. */
  onFrame(fn: (dt: number, t: number) => void): () => void;
  start(): void;
}

export interface LoadingScreen {
  /** Fades out and removes itself. */
  done(): Promise<void>;
}

/* ------------------------------------------------------------------ pigeon (src/pigeon) */

export type PigeonMood = 'calm' | 'offended' | 'glance';

export interface PigeonOptions {
  seed: number;
  isGerald: boolean;
  quality: Quality;
  reducedMotion: boolean;
  bus: EventBus;
}

/**
 * A pigeon knows how to move its own body convincingly. It does NOT decide what to do;
 * the flock brain in src/feeding issues these commands.
 */
export interface Pigeon {
  readonly object: THREE.Object3D;
  readonly isGerald: boolean;
  /** 0 = timid, 1 = bold. Random per bird, stable per seed. */
  readonly temperament: number;
  readonly state: 'idle' | 'walking' | 'pecking' | 'lunging' | 'flying' | 'hopping';

  /** Ground position (y = 0) and facing (radians about +Y; 0 faces +Z). Read-only copies of internal state. */
  readonly position: THREE.Vector3;
  readonly heading: number;
  /** Horizontal distance from the feet to where the beak touches the ground when pecking. */
  readonly reach: number;

  /** Teleport, for spawning. */
  place(at: THREE.Vector3, heading: number): void;
  /**
   * Waddle to a ground point with head-bob, turning naturally. `stopShort` stops that far before the
   * target (use `reach` so the beak lands on a crumb). `urgency` 0..1 trades a stroll for a hurried scuttle.
   * Resolves on arrival, or 'interrupted' if another command replaced it.
   */
  walkTo(target: THREE.Vector3, opts?: { urgency?: number; stopShort?: number }): Promise<'arrived' | 'interrupted'>;
  stop(): void;
  /** Turn in place to face a point. */
  face(point: THREE.Vector3): Promise<void>;
  /** Peck at the ground in front of the beak. Resolves at the moment the crumb is swallowed. */
  peck(): Promise<void>;
  /** Squabble lunge with a wing flap toward a point. */
  lunge(toward: THREE.Vector3): Promise<void>;
  /** Loser: sidestep and a sulky head-shake. */
  sulk(): Promise<void>;
  /** Puffed, back half-turned toward `viewer` when offended; a quick look when glancing. */
  setMood(mood: PigeonMood, viewer: THREE.Vector3): void;
  /** Flutter in from off-screen and land. With reduced motion, appear in place. */
  flyIn(from: THREE.Vector3, to: THREE.Vector3): Promise<void>;
  /** Hop up onto (or down from) a raised spot such as the bench. */
  hopTo(target: THREE.Vector3): Promise<void>;
  /** Idle life: occasional coo, preen, look around. Called by the brain when nothing else is going on. */
  idle(): void;

  update(dt: number, t: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

export type CreatePigeon = (opts: PigeonOptions) => Pigeon;

/* ------------------------------------------------------------------ state (src/state) */

export type GeraldStage = 0 | 1 | 2 | 3;

export interface VisitSnapshot {
  /** Streak to show right now (0 if never fed). */
  streak: number;
  familiarity: number;
  totalDaysFed: number;
  flockSize: number;
  geraldStage: GeraldStage;
  /** True if this visit started after one or more missed days and they haven't forgiven yet. */
  offended: boolean;
  firstVisitEver: boolean;
  hasThrownEver: boolean;
  fedToday: boolean;
}

export interface VisitState {
  snapshot(): VisitSnapshot;
  /** Call on every crumb toss. Commits a fed day the first time each local day; returns true if that happened. */
  recordToss(now?: Date): boolean;
  markHintSeen(): void;
  getSoundOn(): boolean;
  setSoundOn(on: boolean): void;
}

/* ------------------------------------------------------------------ net (src/net) */

export interface CounterClient {
  /** Count one tossed crumb locally and queue it for the next batch. */
  add(n?: number): void;
  /** Displayed total: last server total plus anything queued/unconfirmed. */
  onTotal(fn: (total: number) => void): () => void;
  dispose(): void;
}

/* ------------------------------------------------------------------ feeding (src/feeding) */

export interface FeedingDeps {
  scene: SceneHandle;
  bus: EventBus;
  env: Env;
  state: VisitState;
  createPigeon: CreatePigeon;
}

export interface FeedingHandle {
  /** Spawns the starting flock (no flutter-in) and arms input. */
  start(): void;
  dispose(): void;
}
