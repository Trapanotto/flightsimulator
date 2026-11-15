/**
 * TACAN channels and their paired VHF frequencies (ICAO Annex 10, volume I, table A of the DME
 * chapter): X channels 17 to 59 pair with 108.00 to 112.20 MHz and 70 to 126 with 112.30 to
 * 117.90 MHz, in 0.1 MHz steps. Channels 1 to 16 and 60 to 69 have no VHF pairing. The Hornet's
 * TACAN is the NAV 2 receiver tuned to the paired frequency: a VORTAC's or a VOR-DME's
 * bearing and range are what a TACAN would show.
 */
import type { Cockpit } from '../cockpit';

/** Paired VOR/ILS frequency of an X channel, kHz, or undefined for an unpaired channel. */
export function tacanFrequency(channel: number): number | undefined {
  const ch = Math.round(channel);
  if (ch >= 17 && ch <= 59) return 108_000 + (ch - 17) * 100;
  if (ch >= 70 && ch <= 126) return 112_300 + (ch - 70) * 100;
  return undefined;
}

/** The TACAN channel of a paired frequency (kHz), or undefined. */
export function tacanChannel(frequency: number): number | undefined {
  const f = Math.round(frequency / 100) * 100;
  if (f >= 108_000 && f <= 112_200) return 17 + (f - 108_000) / 100;
  if (f >= 112_300 && f <= 117_900) return 70 + (f - 112_300) / 100;
  return undefined;
}

/**
 * NAV 2 as the TACAN: tuned by `tacanChannel`, following the HSI course (`obs1`). An unpaired
 * channel tunes nothing (0 kHz finds no station).
 */
export function tacanTuning(cockpit: Cockpit): { frequency: number; course: number } {
  return {
    frequency: tacanFrequency(cockpit.get('tacanChannel')) ?? 0,
    course: cockpit.get('obs1'),
  };
}
