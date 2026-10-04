'use strict';

// Pure domain logic: validation, conflict detection, patch application and
// normalized per-row run-length encoding. No I/O lives here so the rules can
// be unit tested in isolation.

const MAX_DIM = 10000; // max rows or columns per mask
const MAX_AREA = 10_000_000; // max rows * columns
const MAX_INTERVALS = 100_000; // max intervals in one patch

class DomainError extends Error {
  constructor(code, message, statusCode = 400, extra = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.statusCode = statusCode;
    if (extra) Object.assign(this, extra);
  }
}

function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function validateMaskId(maskId) {
  if (typeof maskId !== 'string' || maskId.trim() === '') {
    throw new DomainError('VALIDATION_ERROR', 'maskId must be a non-empty string');
  }
  if (maskId.length > 128) {
    throw new DomainError('VALIDATION_ERROR', 'maskId must be at most 128 characters');
  }
  return maskId;
}

function validateCreateEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DomainError('VALIDATION_ERROR', 'request body must be a JSON object');
  }
  if (body.type !== 'create') {
    throw new DomainError('VALIDATION_ERROR', `expected type "create", got ${JSON.stringify(body.type)}`);
  }
  const maskId = validateMaskId(body.maskId);
  const { rows, cols } = body;
  if (!isInt(rows) || !isInt(cols) || rows < 1 || cols < 1) {
    throw new DomainError('VALIDATION_ERROR', 'rows and cols must be positive integers');
  }
  if (rows > MAX_DIM || cols > MAX_DIM) {
    throw new DomainError('VALIDATION_ERROR', `rows and cols must each be at most ${MAX_DIM}`);
  }
  if (rows * cols > MAX_AREA) {
    throw new DomainError('VALIDATION_ERROR', `rows * cols must be at most ${MAX_AREA}`);
  }
  return { maskId, rows, cols };
}

// Validates fields that do not depend on the mask dimensions. Interval bounds
// against rows/cols are checked in validateIntervalBounds once the mask is
// loaded. Returns intervals sorted by (row, start).
function validatePatchEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DomainError('VALIDATION_ERROR', 'request body must be a JSON object');
  }
  if (body.type !== 'patch') {
    throw new DomainError('VALIDATION_ERROR', `expected type "patch", got ${JSON.stringify(body.type)}`);
  }
  const maskId = validateMaskId(body.maskId);

  const baseRevision = body.baseRevision;
  if (!isInt(baseRevision) || baseRevision < 0) {
    throw new DomainError('VALIDATION_ERROR', 'baseRevision must be a non-negative integer');
  }

  const rawIntervals = body.intervals;
  if (!Array.isArray(rawIntervals) || rawIntervals.length === 0) {
    throw new DomainError('VALIDATION_ERROR', 'intervals must be a non-empty array');
  }
  if (rawIntervals.length > MAX_INTERVALS) {
    throw new DomainError('VALIDATION_ERROR', `a patch may contain at most ${MAX_INTERVALS} intervals`);
  }

  const intervals = rawIntervals.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DomainError('VALIDATION_ERROR', `intervals[${index}] must be an object`);
    }
    const { row, start, end, label } = raw;
    if (!isInt(row) || row < 0) {
      throw new DomainError('VALIDATION_ERROR', `intervals[${index}].row must be a non-negative integer`);
    }
    if (row > MAX_DIM) {
      throw new DomainError('VALIDATION_ERROR', `intervals[${index}].row is out of range`);
    }
    if (!isInt(start) || !isInt(end) || start < 0 || end < 0) {
      throw new DomainError('VALIDATION_ERROR', `intervals[${index}] bounds must be non-negative integers`);
    }
    if (start >= end) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `intervals[${index}] must be non-empty half-open ranges (start < end)`
      );
    }
    if (end > MAX_DIM) {
      throw new DomainError('VALIDATION_ERROR', `intervals[${index}].end is out of range`);
    }
    if (!isInt(label) || label < 0 || label > 255) {
      throw new DomainError('VALIDATION_ERROR', `intervals[${index}].label must be an integer in [0,255]`);
    }
    return { row, start, end, label };
  });

  intervals.sort((a, b) => a.row - b.row || a.start - b.start || a.end - b.end);

  // Intervals inside one patch are not allowed to overlap (adjacent is fine).
  for (let i = 1; i < intervals.length; i += 1) {
    const prev = intervals[i - 1];
    const cur = intervals[i];
    if (cur.row === prev.row && cur.start < prev.end) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'intervals in the same patch must not overlap: ' +
          `row ${cur.row} ranges [${prev.start},${prev.end}) and [${cur.start},${cur.end}) overlap`
      );
    }
  }

  return { maskId, baseRevision, intervals };
}

function validateIntervalBounds(intervals, rows, cols) {
  for (const iv of intervals) {
    if (iv.row >= rows) {
      throw new DomainError('VALIDATION_ERROR', `row ${iv.row} is outside the mask (rows=${rows})`);
    }
    if (iv.end > cols) {
      throw new DomainError('VALIDATION_ERROR', `range [${iv.start},${iv.end}) exceeds mask width (cols=${cols})`);
    }
  }
}

// Returns the union of pixels already touched by a successful patch *after*
// baseRevision, expressed as merged, per-row sorted half-open intervals.
function detectConflicts(mask, intervals, baseRevision) {
  const fragments = [];
  for (const iv of intervals) {
    const rowBase = iv.row * mask.cols;
    let p = iv.start;
    while (p < iv.end) {
      if (mask.touchedAt[rowBase + p] > baseRevision) {
        const start = p;
        do {
          p += 1;
        } while (p < iv.end && mask.touchedAt[rowBase + p] > baseRevision);
        fragments.push({ row: iv.row, start, end: p });
      } else {
        p += 1;
      }
    }
  }
  return mergeRanges(fragments);
}

// Sorts by (row, start) and unions ranges that overlap or are adjacent, so the
// conflict report is normalized.
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.row - b.row || a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.row === range.row && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ row: range.row, start: range.start, end: range.end });
    }
  }
  return merged;
}

// Writes the patch and stamps every touched pixel with the new revision.
function applyPatch(mask, intervals, newRevision) {
  for (const iv of intervals) {
    const rowBase = iv.row * mask.cols;
    for (let p = iv.start; p < iv.end; p += 1) {
      mask.labels[rowBase + p] = iv.label;
      mask.touchedAt[rowBase + p] = newRevision;
    }
  }
  mask.revision = newRevision;
}

// Full-coverage per-row RLE. Adjacent runs with the same label are collapsed,
// so concatenating a row's runs always reproduces [0, cols).
function encodeRLE(mask) {
  const rows = [];
  for (let r = 0; r < mask.rows; r += 1) {
    const rowBase = r * mask.cols;
    const runs = [];
    let runStart = 0;
    let runLabel = mask.labels[rowBase];
    for (let p = 1; p < mask.cols; p += 1) {
      const label = mask.labels[rowBase + p];
      if (label !== runLabel) {
        runs.push({ start: runStart, length: p - runStart, label: runLabel });
        runStart = p;
        runLabel = label;
      }
    }
    runs.push({ start: runStart, length: mask.cols - runStart, label: runLabel });
    rows.push(runs);
  }
  return rows;
}

module.exports = {
  DomainError,
  MAX_DIM,
  validateCreateEvent,
  validatePatchEvent,
  validateIntervalBounds,
  detectConflicts,
  mergeRanges,
  applyPatch,
  encodeRLE
};
