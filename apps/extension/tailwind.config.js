/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './entrypoints/**/*.{html,tsx,ts}',
    './components/**/*.{tsx,ts}',
  ],
  theme: {
    extend: {
      colors: {
        'claude-orange': '#da7756',
        'claude-bg': '#2b2a27',
        'claude-surface': '#393835',
        'claude-border': '#4a4945',
        'claude-text': '#e8e4dd',
        'claude-text-muted': '#a8a49c',
      },
    },
  },
  plugins: [],
};
