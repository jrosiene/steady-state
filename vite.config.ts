import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // expose on all interfaces (Tailscale, LAN, etc.)
    port: 5173,
  },
  test: {
    // Most of this suite is calibration: it walks the whole archetype library at
    // several severities and integrates a twelve-hour shift for each one. Those
    // are seconds of real work, not hung tests, and the library keeps growing —
    // a five-second default turns every new case into a spurious failure.
    testTimeout: 300_000,
  },
})
