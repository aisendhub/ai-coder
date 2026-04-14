/**
 * Play a short notification tone using the Web Audio API.
 * No audio files required — works in any browser after a user gesture.
 */

let ctx: AudioContext | null = null

function getContext(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

/**
 * Two-tone chime that signals "done".
 * Plays two short sine-wave notes in quick succession (~300ms total).
 */
export function playDoneSound() {
  try {
    const ac = getContext()

    // Resume if suspended (browsers suspend until user gesture)
    if (ac.state === "suspended") void ac.resume()

    const now = ac.currentTime

    // Gain envelope so it doesn't click
    const gain = ac.createGain()
    gain.connect(ac.destination)
    gain.gain.setValueAtTime(0.18, now)
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35)

    // Note 1 – E5 (659 Hz)
    const o1 = ac.createOscillator()
    o1.type = "sine"
    o1.frequency.value = 659
    o1.connect(gain)
    o1.start(now)
    o1.stop(now + 0.15)

    // Note 2 – G5 (784 Hz)  — ascending = feels positive
    const o2 = ac.createOscillator()
    o2.type = "sine"
    o2.frequency.value = 784
    o2.connect(gain)
    o2.start(now + 0.15)
    o2.stop(now + 0.3)
  } catch {
    // Audio not available — silently ignore
  }
}
