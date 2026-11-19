import { cloudDraw, cloudSeed } from './cloud-seed.ts'

export const defaultCloudCoverage = 0.75

// Shared by rendering, diagnostics and reveal hit testing. No checkerboard.
export const isFogPatternSelected = ({ x, y }) =>
  cloudDraw(cloudSeed, x, y, 0xc10d) < defaultCloudCoverage

export const fogShapeSeed = ({ x, y }) => cloudDraw(cloudSeed, x, y, 3) * 65536
