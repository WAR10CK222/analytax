export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const isoNow = (clock: Clock): string => clock.now().toISOString();
