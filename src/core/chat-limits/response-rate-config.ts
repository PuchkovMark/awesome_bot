export const responseRateWindowMs = 60_000;

const defaults = {
  responsesPerMinute: 6,
  floodThreshold: 5,
  floodWindowMs: 10_000,
};

export type ResponseRateConfig = Readonly<typeof defaults>;

export function responseRateConfig(input: Partial<ResponseRateConfig> = {}): ResponseRateConfig {
  const config = { ...defaults, ...input };
  if (Object.values(config).some(value => !Number.isSafeInteger(value) || value <= 0)
    || config.floodWindowMs > 8_640_000_000_000_000 - Date.now()) {
    throw new TypeError('Response rate: invalid_configuration');
  }
  return Object.freeze(config);
}
