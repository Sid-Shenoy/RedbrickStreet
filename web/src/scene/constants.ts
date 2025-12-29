// Surface texture scale: each texture image represents 0.5m x 0.5m.
export const SURFACE_TEX_METERS = 0.5;

// Vertical layout (meters)
export const PLOT_Y = 0.2;
export const FIRST_FLOOR_Y = 0.4;
export const SECOND_FLOOR_Y = 3.4;
export const CEILING_Y = 6.4;

// Boundary wall rendering (between regions + along exterior edges)
export const BOUNDARY_WALL_T = 0.06;

// Door opening height used when carving gaps in boundary walls.
// Door meshes aren't rendered yet; this creates believable openings under a lintel.
export const DOOR_OPENING_H = 2.05;

// Small threshold wall block under door openings (meters).
// Prevents seeing the void below at door bottoms without introducing floor z-fighting.
export const DOOR_SILL_H = 0.02;

// Small vertical separation between a ceiling plane and the floor plane above it (meters).
// Prevents z-fighting while remaining visually imperceptible.
export const INTER_FLOOR_CEILING_EPS = 0.01;

// Auto-step (meters)
export const MAX_STEP_UP = 0.5;
export const STEP_PROBE_DIST = 0.55;
export const STEP_NUDGE_FWD = 0.05;
