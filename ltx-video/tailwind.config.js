/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#1a1a1a',
        foreground: '#ffffff',
        card: '#242424',
        'card-foreground': '#ffffff',
        border: '#333333',
        input: '#2a2a2a',
        primary: {
          DEFAULT: '#6366f1',
          foreground: '#ffffff',
        },
        secondary: {
          DEFAULT: '#3f3f46',
          foreground: '#ffffff',
        },
        muted: {
          DEFAULT: '#27272a',
          foreground: '#a1a1aa',
        },
        accent: {
          DEFAULT: '#6366f1',
          foreground: '#ffffff',
        },
      },
      borderRadius: {
        lg: '0.75rem',
        md: '0.5rem',
        sm: '0.25rem',
      },
    },
  },
  plugins: [],
}
