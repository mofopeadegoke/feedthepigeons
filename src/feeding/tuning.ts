/**
 * Feel knobs for throwing, crumbs and the flock. Kept in one place so the craft pass is
 * a matter of nudging numbers, not hunting through logic.
 */
export const TUNING = {
  throw: {
    /** Minimum gap between tosses (≈ 8 per second). */
    minIntervalMs: 125,
    /** Below this much pointer travel a release is a tap, not a throw. */
    tapSlopPx: 10,
    /** Drag that has crept back to within this many px of the press point (or below it) cancels. */
    cancelPx: 16,
    /** Distance curve: d = min + (max - min) * f^exp, where f is drag length over the reference length. */
    minDistance: 0.9,
    maxDistance: 13.5,
    curveExponent: 2.2,
    /** Reference drag length as a fraction of canvas height, clamped to sane px. */
    refFraction: 0.6,
    refMinPx: 220,
    refMaxPx: 560,
    /** How strongly sideways drag turns the throw, and the widest it may turn (radians). */
    aimGain: 0.85,
    aimMax: 1.1,
    /** Underhand tap drop, metres in front of the bread. */
    dropMin: 0.8,
    dropMax: 1.5,
    dropSpread: 0.28,
    /** Never land a crumb behind or on top of the bread. */
    minAheadOfBread: 0.55,
  },
  arc: {
    gravity: 9.8,
    /** Apex height above the start = base + perMetre * distance, capped. */
    apexBase: 0.28,
    apexPerMetre: 0.2,
    apexMax: 2.6,
    reducedApexBase: 0.1,
    reducedApexPerMetre: 0.06,
    reducedApexMax: 0.7,
    dropApex: 0.14,
    spinMin: 9,
    spinMax: 22,
    reducedSpinMin: 1.5,
    reducedSpinMax: 3.5,
  },
  crumb: {
    sizeMin: 0.011,
    sizeMax: 0.022,
    restitution: 0.32,
    groundFriction: 7,
    /** Crumbs bigger than this need two pecks; the first nudges and halves them. */
    twoPeckSize: 0.018,
    maxOnGround: 30,
    fadeSeconds: 0.9,
  },
  ring: {
    baseRadius: 0.16,
    radiusPerMetre: 0.022,
    fadeIn: 0.18,
    fadeOut: 0.3,
    /** Keyboard ring speed in m/s, scaled up with distance so far aiming isn't a slog. */
    keySpeedLateral: 2.0,
    keySpeedDepth: 3.2,
    keyAccelSeconds: 0.22,
    driftSeconds: 0.7,
  },
  flock: {
    /** Interest radius = base + temperament * perTemperament. */
    interestBase: 1.6,
    interestPerTemperament: 2.6,
    /** Gerald's interest radius per stage. */
    geraldInterest: [3.2, 4.4, 6.5, 7.5],
    /** Gerald won't target crumbs closer to the viewer than this (stage 0, 1, 2, 3). */
    geraldMinViewerDistance: [4.2, 2.6, 0, 0],
    /** And won't stand closer than this while milling about. */
    geraldIdleMinViewerDistance: [3.6, 2.5, 1.6, 1.4],
    /** Seconds before a bird notices a fresh crumb: bold birds are quicker. */
    reactMin: 0.08,
    reactMax: 0.75,
    thinkInterval: 0.18,
    personalSpace: 0.42,
    /** Two birds whose crumbs are this close are in each other's way. */
    squabbleRange: 0.3,
    /** How close both must be to their crumb before tempers flare. */
    squabbleApproach: 0.75,
    squabbleChance: 0.35,
    squabbleBirdCooldown: 7,
    squabbleGlobalCooldown: 4,
    sulkSeconds: [1.6, 3.2],
    idleGap: [2.2, 6.5],
    wanderStep: [0.3, 1.2],
    /** Birds that drift farther than this from the flock centre amble back. */
    cohesionRadius: 2.4,
    flyInStagger: [0.35, 0.9],
    benchChancePerIdle: 0.12,
    benchStay: [8, 18],
    /** "Occasionally": after a visit, Gerald stays on the ground for a good while. */
    benchCooldown: [25, 50],
    offended: { ignore: 3, glanceAt: 4, forgiveAt: 5, geraldGlanceAt: 3, geraldForgiveAt: 4, glanceHold: 1.8 },
  },
} as const;
