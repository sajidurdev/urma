type Rational = Readonly<{ numerator: bigint; denominator: bigint }>;

const VIDEO_TIMING_CONTRACT_VERSION = 2;

export type VideoPtsCoverage = Readonly<{
  start: Rational;
  end: Rational;
  startSeconds: number;
  endSeconds: number;
  startPts: string | null;
  endPts: string | null;
  durationTs: string | null;
  timeBase: string | null;
}>;

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === 0n ? 1n : a;
}

function rational(numerator: bigint, denominator: bigint): Rational | null {
  if (denominator === 0n) return null;
  const sign = denominator < 0n ? -1n : 1n;
  const normalizedNumerator = numerator * sign;
  const normalizedDenominator = denominator * sign;
  const divisor = gcd(normalizedNumerator, normalizedDenominator);
  return {
    numerator: normalizedNumerator / divisor,
    denominator: normalizedDenominator / divisor,
  };
}

function add(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  )!;
}

function compare(left: Rational, right: Rational): number {
  const difference = left.numerator * right.denominator -
    right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function secondsValue(value: Rational): number {
  return Number(value.numerator) / Number(value.denominator);
}

function parseInteger(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  if (typeof value !== "string" || !/^-?\d+$/u.test(value.trim())) return null;
  try {
    return BigInt(value.trim());
  } catch {
    return null;
  }
}

function parseDecimal(value: unknown): Rational | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    value = value.toString();
  }
  if (typeof value !== "string") return null;
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(
    value.trim(),
  );
  if (!match) return null;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  const digits = `${match[2]}${fraction}`;
  let numerator = BigInt(digits);
  let denominator = 10n ** BigInt(fraction.length);
  if (exponent > 0) numerator *= 10n ** BigInt(exponent);
  if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
  if (match[1] === "-") numerator = -numerator;
  return rational(numerator, denominator);
}

function parseTimeBase(
  value: unknown,
): { rational: Rational; text: string } | null {
  if (typeof value !== "string") return null;
  const match = /^(-?\d+)\/(\d+)$/u.exec(value.trim());
  if (!match) return null;
  const numerator = parseInteger(match[1]);
  const denominator = parseInteger(match[2]);
  if (
    numerator === null ||
    denominator === null ||
    numerator <= 0n ||
    denominator <= 0n
  ) {
    return null;
  }
  const valueRational = rational(numerator, denominator);
  return valueRational === null ? null : {
    rational: valueRational,
    text: `${valueRational.numerator}/${valueRational.denominator}`,
  };
}

function integerText(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function buildCoverage(
  start: Rational,
  end: Rational,
  values: {
    startPts: bigint | null;
    endPts: bigint | null;
    durationTs: bigint | null;
    timeBase: string | null;
  },
): VideoPtsCoverage | null {
  if (compare(end, start) <= 0) return null;
  const startSeconds = secondsValue(start);
  const endSeconds = secondsValue(end);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    return null;
  }
  return {
    start,
    end,
    startSeconds,
    endSeconds,
    startPts: integerText(values.startPts),
    endPts: integerText(values.endPts),
    durationTs: integerText(values.durationTs),
    timeBase: values.timeBase,
  };
}

/** Parse the selected video stream's retained presentation-time coverage. */
export function parseVideoStreamCoverage(
  stream: Readonly<Record<string, unknown>>,
): VideoPtsCoverage | null {
  const timeBase = parseTimeBase(stream.time_base);
  const startPts = parseInteger(stream.start_pts);
  const durationTs = parseInteger(stream.duration_ts);
  if (
    timeBase !== null &&
    startPts !== null &&
    durationTs !== null &&
    durationTs > 0n
  ) {
    const start = rational(
      startPts * timeBase.rational.numerator,
      timeBase.rational.denominator,
    );
    const duration = rational(
      durationTs * timeBase.rational.numerator,
      timeBase.rational.denominator,
    );
    if (start !== null && duration !== null) {
      const end = add(start, duration);
      return buildCoverage(start, end, {
        startPts,
        endPts: startPts + durationTs,
        durationTs,
        timeBase: timeBase.text,
      });
    }
  }

  const preciseStart = timeBase !== null && startPts !== null
    ? rational(
      startPts * timeBase.rational.numerator,
      timeBase.rational.denominator,
    )
    : null;
  const preciseDuration =
    timeBase !== null && durationTs !== null && durationTs > 0n
      ? rational(
        durationTs * timeBase.rational.numerator,
        timeBase.rational.denominator,
      )
      : null;
  // An absent presentation origin cannot establish a source-to-media mapping.
  // In particular, do not turn unknown origin into a zero-origin seek.
  const start = preciseStart ?? parseDecimal(stream.start_time);
  const duration = preciseDuration ?? parseDecimal(stream.duration);
  if (
    start === null ||
    duration === null ||
    compare(duration, rational(0n, 1n)!) <= 0
  ) {
    return null;
  }
  return buildCoverage(start, add(start, duration), {
    startPts: null,
    endPts: null,
    durationTs: null,
    timeBase: timeBase?.text ?? null,
  });
}

/** Parse the retained PTS-aware producer fields shared by exact media paths. */
export function parseStoredVideoCoverage(
  producer: Readonly<Record<string, unknown>>,
): VideoPtsCoverage | null {
  if (producer.validatedVideoTimingVersion !== VIDEO_TIMING_CONTRACT_VERSION) {
    return null;
  }
  const hasPrecisePtsMetadata = [
    producer.validatedVideoStartPts,
    producer.validatedVideoEndPts,
    producer.validatedVideoDurationTs,
  ].some((value) => value !== null && value !== undefined);
  const startPts = parseInteger(producer.validatedVideoStartPts);
  const endPts = parseInteger(producer.validatedVideoEndPts);
  const durationTs = parseInteger(producer.validatedVideoDurationTs);
  const timeBase = parseTimeBase(producer.validatedVideoTimeBase);
  const derivedEndPts = endPts ??
    (startPts !== null && durationTs !== null && durationTs > 0n
      ? startPts + durationTs
      : null);
  if (
    startPts !== null &&
    derivedEndPts !== null &&
    derivedEndPts > startPts &&
    timeBase !== null
  ) {
    const start = rational(
      startPts * timeBase.rational.numerator,
      timeBase.rational.denominator,
    );
    const end = rational(
      derivedEndPts * timeBase.rational.numerator,
      timeBase.rational.denominator,
    );
    if (start !== null && end !== null) {
      return buildCoverage(start, end, {
        startPts,
        endPts: derivedEndPts,
        durationTs: durationTs !== null && durationTs > 0n
          ? durationTs
          : derivedEndPts - startPts,
        timeBase: timeBase.text,
      });
    }
  }

  // An artifact that advertises precise fields must remain precise. Do not
  // silently downgrade malformed PTS metadata to rounded display seconds.
  if (hasPrecisePtsMetadata) return null;

  const start = parseDecimal(producer.validatedVideoStartTime) ??
    parseDecimal(producer.validatedVideoStart);
  const end = parseDecimal(producer.validatedVideoEndTime) ??
    parseDecimal(producer.validatedVideoEnd);
  if (start === null || end === null) return null;
  return buildCoverage(start, end, {
    startPts: null,
    endPts: null,
    durationTs: null,
    timeBase: null,
  });
}

/** Parse the current PTS-aware bounded-section producer contract. */
export function parseStoredBoundedVideoCoverage(
  producer: Readonly<Record<string, unknown>>,
): VideoPtsCoverage | null {
  if (producer.version !== "bounded-section") return null;
  return parseStoredVideoCoverage(producer);
}

export function serializeVideoPtsCoverage(
  coverage: VideoPtsCoverage,
): Readonly<Record<string, unknown>> {
  return {
    validatedVideoTimingVersion: VIDEO_TIMING_CONTRACT_VERSION,
    validatedVideoStart: coverage.startSeconds,
    validatedVideoEnd: coverage.endSeconds,
    validatedVideoStartTime: coverage.startSeconds.toFixed(9),
    validatedVideoEndTime: coverage.endSeconds.toFixed(9),
    validatedVideoStartPts: coverage.startPts,
    validatedVideoEndPts: coverage.endPts,
    validatedVideoDurationTs: coverage.durationTs,
    validatedVideoTimeBase: coverage.timeBase,
  };
}

export function isTimestampCovered(
  coverage: VideoPtsCoverage,
  nominalLocalMs: number,
): boolean {
  if (!Number.isSafeInteger(nominalLocalMs) || nominalLocalMs < 0) return false;
  const target = rational(BigInt(nominalLocalMs), 1_000n)!;
  // The range is exact: the first retained presentation timestamp is included and the end is exclusive.
  return (
    compare(target, coverage.start) >= 0 && compare(target, coverage.end) < 0
  );
}

export function physicalSeekMs(
  coverage: VideoPtsCoverage,
  nominalLocalMs: number,
): number {
  const target = rational(BigInt(nominalLocalMs), 1_000n)!;
  const delta = rational(
    target.numerator * coverage.start.denominator -
      coverage.start.numerator * target.denominator,
    target.denominator * coverage.start.denominator,
  )!;
  const milliseconds = secondsValue(delta) * 1_000;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError(
      "PTS-aware bounded seek was not a finite non-negative value",
    );
  }
  return milliseconds;
}
