/** Color palette for a given theme mode. */
export interface ThemeColors {
  orange: string;
  bg: string;
  surface: string;
  surfaceHi: string;
  border: string;
  text: string;
  muted: string;
  green: string;
}

/** Dark-mode palette matching claude.ai's default appearance. */
export const DARK: ThemeColors = {
  orange: '#da7756',
  bg: '#1f1e1c',
  surface: '#2a2a27',
  surfaceHi: '#34332f',
  border: '#3d3d38',
  text: '#e8e4dd',
  muted: '#9b9790',
  green: '#5fb37e',
};

/** Light-mode palette matching claude.ai's light appearance. */
export const LIGHT: ThemeColors = {
  orange: '#c75c3a',
  bg: '#ffffff',
  surface: '#f7f5f2',
  surfaceHi: '#edebe7',
  border: '#e0ded8',
  text: '#1a1815',
  muted: '#6e6b65',
  green: '#3b8c53',
};

/** Legacy alias — components should migrate to useThemeColors(). */
export const CL = DARK;
