// Moves als data — de vechtset is hier uit te breiden zonder engine-code aan
// te raken. Ontwerp volgt vechtgame-praktijk (zie onderzoek in README/PR):
// - anticipatie -> strike -> follow-through -> recovery, met per-segment easing
//   ("out" = zweepslag: snel vertrekken, uitgestrekt afremmen)
// - hitFrom/hitTo: het actieve raakvenster (genormaliseerde cliptijd)
// - chainFrom/chainTo: cancel-venster; input hierbinnen bufferert de volgende
//   move in de keten (het klassieke SF2 "2-in-1"-principe)
// - root: voorwaartse verplaatsing (m) over de clip — gewicht in de uitval
// - hitstop: bevriezing (s) op impact; shake/knockback verkopen de klap
//
// pose-rotaties in rad per joint: torso, head, sL/sR (schouders),
// eL/eR (ellebogen), hL/hR (heupen), kL/kR (knieen)

export const MOVES = {
  // --- stoot-keten (A A A) ---------------------------------------------------
  jab: {
    dur: 0.32, hitFrom: 0.30, hitTo: 0.52, reach: 1.4, dmg: 1, limb: 'armR',
    knockback: 0.35, hitstop: 0.07, chainFrom: 0.45, chainTo: 0.95, chainsTo: 'cross',
    root: [[0, 0], [0.4, 0.25], [1, 0.1]],
    frames: [
      { at: 0.0,  ease: 'smooth', pose: { sR: [-0.5, 0, -0.2], eR: [-2.0, 0, 0], sL: [-0.7, 0, 0.35], eL: [-1.9, 0, 0], torso: [0.06, 0.35, 0] } },
      { at: 0.38, ease: 'out',    pose: { sR: [-1.6, 0, 0.05], eR: [-0.06, 0, 0], sL: [-0.75, 0, 0.4], eL: [-2.1, 0, 0], torso: [0.14, -0.5, 0], head: [0.08, -0.2, 0] } },
      { at: 1.0,  ease: 'smooth', pose: { sR: [-0.5, 0, -0.2], eR: [-1.9, 0, 0], sL: [-0.7, 0, 0.35], eL: [-1.9, 0, 0], torso: [0.06, 0.2, 0] } },
    ],
  },
  cross: {
    dur: 0.42, hitFrom: 0.32, hitTo: 0.55, reach: 1.5, dmg: 1, limb: 'armL',
    knockback: 0.6, hitstop: 0.09, chainFrom: 0.5, chainTo: 0.95, chainsTo: 'backfist',
    root: [[0, 0], [0.45, 0.45], [1, 0.15]],
    frames: [
      { at: 0.0,  ease: 'smooth', pose: { sL: [-0.6, 0, 0.3], eL: [-2.0, 0, 0], sR: [-0.6, 0, -0.3], eR: [-1.9, 0, 0], torso: [0.05, -0.5, 0] } },
      { at: 0.18, ease: 'in',     pose: { sL: [-0.4, 0, 0.35], eL: [-2.2, 0, 0], torso: [0.1, -0.75, 0], head: [0, -0.15, 0] } },
      { at: 0.45, ease: 'out',    pose: { sL: [-1.65, 0, -0.05], eL: [-0.04, 0, 0], sR: [-0.7, 0, -0.45], eR: [-2.1, 0, 0], torso: [0.2, 0.8, 0], head: [0.1, 0.25, 0] } },
      { at: 1.0,  ease: 'smooth', pose: { sL: [-0.6, 0, 0.3], eL: [-1.9, 0, 0], torso: [0.05, 0.1, 0] } },
    ],
  },
  backfist: {
    dur: 0.6, hitFrom: 0.42, hitTo: 0.62, reach: 1.7, dmg: 2, limb: 'armR',
    knockback: 1.4, hitstop: 0.13, heavy: true,
    root: [[0, 0], [0.5, 0.5], [1, 0.2]],
    frames: [
      { at: 0.0,  ease: 'smooth', pose: { torso: [0.05, 0.3, 0], sR: [-0.6, 0, -0.3], eR: [-2.0, 0, 0] } },
      { at: 0.28, ease: 'in',     pose: { torso: [0.08, 1.5, -0.1], sR: [-1.3, 0, -1.1], eR: [-1.6, 0, 0], head: [0, 0.6, 0] } },
      { at: 0.52, ease: 'out',    pose: { torso: [0.12, -1.9, 0.15], sR: [-1.55, 0, 0.9], eR: [-0.05, 0, 0], head: [0, -0.7, 0], hL: [0.18, 0, 0] } },
      { at: 1.0,  ease: 'smooth', pose: { torso: [0.05, 0, 0], sR: [-0.5, 0, -0.2], eR: [-1.8, 0, 0] } },
    ],
  },

  // --- trap-keten (B B B) ----------------------------------------------------
  frontkick: {
    dur: 0.5, hitFrom: 0.36, hitTo: 0.58, reach: 1.8, dmg: 1, limb: 'legR',
    knockback: 1.0, hitstop: 0.09, chainFrom: 0.55, chainTo: 0.95, chainsTo: 'roundhouse',
    root: [[0, 0], [0.45, 0.3], [1, 0.1]],
    frames: [
      { at: 0.0,  ease: 'smooth', pose: { hR: [0.25, 0, 0], kR: [0.4, 0, 0], torso: [0.12, 0, 0] } },
      { at: 0.26, ease: 'in',     pose: { hR: [-1.5, 0, 0], kR: [2.2, 0, 0], torso: [-0.1, 0, 0], sL: [-0.9, 0, 0.35], sR: [-0.9, 0, -0.35] } },
      { at: 0.48, ease: 'out',    pose: { hR: [-1.65, 0, 0], kR: [0.08, 0, 0], torso: [-0.32, 0, 0], head: [-0.15, 0, 0], sL: [-1.0, 0, 0.4], sR: [-1.0, 0, -0.4] } },
      { at: 0.72, ease: 'smooth', pose: { hR: [-0.9, 0, 0], kR: [1.4, 0, 0], torso: [-0.1, 0, 0] } },
      { at: 1.0,  ease: 'smooth', pose: { hR: [0, 0, 0], kR: [0, 0, 0], torso: [0, 0, 0] } },
    ],
  },
  roundhouse: {
    dur: 0.62, hitFrom: 0.4, hitTo: 0.6, reach: 1.9, dmg: 2, limb: 'legL',
    knockback: 1.6, hitstop: 0.12, heavy: true, chainFrom: 0.6, chainTo: 0.95, chainsTo: 'tornado',
    root: [[0, 0], [0.5, 0.35], [1, 0.1]],
    frames: [
      { at: 0.0,  ease: 'smooth', pose: { torso: [0.05, 0.45, 0], hL: [0.3, 0, 0] } },
      { at: 0.28, ease: 'in',     pose: { torso: [0.1, 1.4, -0.28], hL: [-1.15, 0.75, 0], kL: [2.0, 0, 0], sL: [-1.1, 0, 0.45], sR: [-0.8, 0, -0.5], head: [0, 0.5, 0] } },
      { at: 0.52, ease: 'out',    pose: { torso: [0.06, 2.5, -0.4], hL: [-1.6, 1.35, 0], kL: [0.1, 0, 0], sL: [-1.25, 0, 0.55], sR: [-0.7, 0, -0.65], head: [0, 0.9, 0] } },
      { at: 1.0,  ease: 'smooth', pose: { torso: [0, 0, 0], hL: [0, 0, 0], kL: [0, 0, 0] } },
    ],
  },
  tornado: { // 540-achtige spinkick: de finisher-kandidaat van de keten
    dur: 0.85, hitFrom: 0.5, hitTo: 0.7, reach: 2.0, dmg: 3, limb: 'legR',
    knockback: 2.6, hitstop: 0.16, heavy: true, spin: Math.PI * 2,
    root: [[0, 0], [0.55, 0.7], [1, 0.25]],
    frames: [
      { at: 0.0,  ease: 'smooth', pose: { torso: [0.15, -0.5, 0], hR: [0.3, 0, 0] } },
      { at: 0.3,  ease: 'in',     pose: { torso: [0.1, 0.9, -0.15], hR: [-0.8, -0.4, 0], kR: [1.6, 0, 0], sL: [-1.4, 0, 0.5], sR: [-1.4, 0, -0.5] } },
      { at: 0.62, ease: 'out',    pose: { torso: [0.0, 2.2, -0.45], hR: [-1.7, -1.1, 0], kR: [0.05, 0, 0], sL: [-1.5, 0, 0.6], sR: [-0.9, 0, -0.7], head: [0, 1.0, 0] } },
      { at: 1.0,  ease: 'smooth', pose: { torso: [0.05, 0, 0], hR: [0, 0, 0], kR: [0, 0, 0] } },
    ],
  },

  // --- reacties / verdediging -------------------------------------------------
  hitLight: {
    dur: 0.3, frames: [
      { at: 0.0, ease: 'out',    pose: { torso: [-0.4, 0, 0.1], head: [-0.3, 0, 0], sL: [-0.5, 0, 0.35], sR: [-0.5, 0, -0.35] } },
      { at: 1.0, ease: 'smooth', pose: {} },
    ],
  },
  hitHeavy: {
    dur: 0.5, frames: [
      { at: 0.0,  ease: 'out',    pose: { torso: [-0.85, 0.3, 0.2], head: [-0.5, 0, 0], sL: [-1.2, 0, 0.5], sR: [-1.0, 0, -0.5], kL: [0.5, 0, 0], kR: [0.4, 0, 0] } },
      { at: 0.55, ease: 'smooth', pose: { torso: [-0.3, 0.1, 0.05] } },
      { at: 1.0,  ease: 'smooth', pose: {} },
    ],
  },
  block: { // statische houding zolang vastgehouden
    dur: 1, hold: true, frames: [
      { at: 0.0, ease: 'out', pose: { sL: [-1.5, 0, 0.55], eL: [-2.3, 0, 0], sR: [-1.5, 0, -0.55], eR: [-2.3, 0, 0], torso: [0.22, 0, 0], head: [0.15, 0, 0], kL: [0.25, 0, 0], kR: [0.25, 0, 0], hL: [-0.15, 0, 0], hR: [-0.15, 0, 0] } },
      { at: 1.0, ease: 'smooth', pose: { sL: [-1.5, 0, 0.55], eL: [-2.3, 0, 0], sR: [-1.5, 0, -0.55], eR: [-2.3, 0, 0], torso: [0.22, 0, 0], head: [0.15, 0, 0], kL: [0.25, 0, 0], kR: [0.25, 0, 0], hL: [-0.15, 0, 0], hR: [-0.15, 0, 0] } },
    ],
  },
  dodge: { // zijstap-rol met i-frames (invuln in stickman.js)
    dur: 0.38, iFrames: [0.05, 0.8],
    frames: [
      { at: 0.0,  ease: 'in',     pose: { torso: [0.5, 0, 0.4], kL: [1.0, 0, 0], kR: [1.0, 0, 0], hL: [-0.7, 0, 0], hR: [-0.7, 0, 0], head: [0.3, 0, 0] } },
      { at: 0.55, ease: 'out',    pose: { torso: [0.7, 0, -0.3], kL: [1.4, 0, 0], kR: [1.2, 0, 0], hL: [-1.0, 0, 0], hR: [-0.8, 0, 0] } },
      { at: 1.0,  ease: 'smooth', pose: {} },
    ],
  },
};

// combo-startmoves per knop
export const CHAIN_A = 'jab';
export const CHAIN_B = 'frontkick';
