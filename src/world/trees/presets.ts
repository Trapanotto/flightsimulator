import type { DeviceClass } from '../layers';

/** What the tree layer may cost on a device class. Distances are metres at 1080p and 55°. */
export interface TreePreset {
  /**
   * Share of the trees drawn at all. Mobile shows a deterministic subset of the desktop forest
   * (the trees with the lowest rank) with wider crowns, so both see the same trees.
   */
  share: number;
  /** Crown and height scale that makes up for the thinner forest of `share`. */
  crownScale: number;
  /** Full geometry up to here, then the mid level. */
  nearRange: number;
  /** Mid level up to here, then the far level. */
  midRange: number;
  /** All trees up to here; beyond, fewer and slightly bigger ones. */
  thinStart: number;
  /** Trees start to vanish into the photo here and are gone at fadeEnd. */
  fadeStart: number;
  fadeEnd: number;
  /** Cheaper near meshes (fewer whorls and lumps). */
  lite: boolean;
  /** Branch sway near the camera. */
  wind: boolean;
  /** Web Workers building chunks, and chunks built at the same time (also the network limit). */
  workers: number;
  jobsInFlight: number;
  /** Chunks handed to the GPU per frame. */
  uploadsPerFrame: number;
  /** CPU time per frame for height queries (seating trees on the terrain), ms. */
  seatBudgetMs: number;
  /** Height samples per chunk side; trees are seated on this grid. */
  heightGrid: number;
  /** Chunks kept (drawn plus cached). */
  maxChunks: number;
  /** Trees per form drawn with the full mesh at most (the near set). */
  nearCapacity: number;
}

export const TREE_PRESETS: Record<DeviceClass, TreePreset> = {
  desktop: {
    share: 1,
    crownScale: 1,
    nearRange: 200,
    midRange: 1000,
    thinStart: 1200,
    fadeStart: 4200,
    fadeEnd: 6000,
    lite: false,
    wind: true,
    workers: 2,
    jobsInFlight: 4,
    uploadsPerFrame: 1,
    seatBudgetMs: 2.5,
    heightGrid: 97,
    maxChunks: 64,
    nearCapacity: 8000,
  },
  mobile: {
    share: 0.5,
    crownScale: 1.25,
    nearRange: 110,
    midRange: 500,
    thinStart: 600,
    fadeStart: 1900,
    fadeEnd: 2800,
    lite: true,
    wind: false,
    workers: 1,
    jobsInFlight: 2,
    uploadsPerFrame: 1,
    seatBudgetMs: 1.5,
    heightGrid: 65,
    maxChunks: 22,
    nearCapacity: 2500,
  },
};

/** Exponent of the thinning beyond thinStart: the share of trees falls as (thinStart/d)^p. */
export const THIN_POWER = 1.2;
/** Width of the cross-fade between two levels of detail, as a share of the switch distance. */
export const LOD_BAND = 0.015;
/**
 * Spread of the switch distances between trees (share of the distance): each tree changes its
 * level at its own distance, so there is no ring where a whole forest changes at once.
 */
export const LOD_JITTER = 0.16;
