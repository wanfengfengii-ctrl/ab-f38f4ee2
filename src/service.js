'use strict';

// Service orchestration: every operation on a mask runs under that mask's
// mutex, so create-vs-create and concurrent patches are serialized and the
// "check conflicts -> apply -> bump revision" sequence is atomic.

const { getMask, createMask } = require('./store');
const {
  DomainError,
  validateCreateEvent,
  validatePatchEvent,
  validateIntervalBounds,
  detectConflicts,
  applyPatch,
  encodeRLE
} = require('./logic');

function maskNotFound(maskId) {
  return new DomainError('NOT_FOUND', `mask ${JSON.stringify(maskId)} does not exist`, 404);
}

// Returns either { ok: true, mask } or { ok: false, status, body }.
async function handleCreate(body) {
  const event = validateCreateEvent(body);
  // No await between the lookup and the insert, so this check-and-set runs to
  // completion within one event-loop turn; a concurrent create cannot interleave.
  if (getMask(event.maskId)) {
    const existing = getMask(event.maskId);
    // Report the duplicate as an observable conflict at 409 with the current
    // revision, rather than silently overwriting anyone's work.
    const snapshot = await existing.mutex(() => serializeMask(existing));
    return {
      ok: false,
      status: 409,
      body: {
        error: 'MASK_ALREADY_EXISTS',
        message: `mask ${JSON.stringify(event.maskId)} already exists`,
        maskId: event.maskId,
        currentRevision: snapshot.revision
      }
    };
  }

  const created = createMask(event.maskId, event.rows, event.cols);
  return {
    ok: true,
    status: 201,
    body: {
      maskId: created.id,
      rows: created.rows,
      cols: created.cols,
      revision: created.revision,
      message: 'mask created'
    }
  };
}

async function handlePatch(body) {
  const event = validatePatchEvent(body);
  const mask = getMask(event.maskId);
  if (!mask) {
    throw maskNotFound(event.maskId);
  }

  return mask.mutex(() => {
    validateIntervalBounds(event.intervals, mask.rows, mask.cols);

    const currentRevision = mask.revision;
    if (event.baseRevision > currentRevision) {
      // A base from the future is invalid rather than a conflict.
      throw new DomainError(
        'VALIDATION_ERROR',
        `baseRevision ${event.baseRevision} is ahead of current revision ${currentRevision}`
      );
    }

    const conflicts = detectConflicts(mask, event.intervals, event.baseRevision);
    if (conflicts.length > 0) {
      // Whole patch is rejected: no pixels change and no revision is created.
      return {
        ok: false,
        status: 409,
        body: {
          error: 'PATCH_CONFLICT',
          message: 'intervals overlap pixels touched by a later successful patch',
          maskId: mask.id,
          baseRevision: event.baseRevision,
          currentRevision,
          conflicts
        }
      };
    }

    const newRevision = currentRevision + 1;
    applyPatch(mask, event.intervals, newRevision);
    return {
      ok: true,
      status: 200,
      body: {
        maskId: mask.id,
        revision: newRevision,
        previousRevision: currentRevision,
        appliedIntervals: event.intervals.length
      }
    };
  });
}

function serializeMask(mask) {
  return {
    maskId: mask.id,
    rows: mask.rows,
    cols: mask.cols,
    revision: mask.revision,
    runs: encodeRLE(mask)
  };
}

async function handleGet(maskId) {
  if (typeof maskId !== 'string' || maskId.trim() === '') {
    throw new DomainError('VALIDATION_ERROR', 'maskId must be a non-empty string');
  }
  const mask = getMask(maskId);
  if (!mask) {
    throw maskNotFound(maskId);
  }
  const snapshot = await mask.mutex(() => serializeMask(mask));
  return { ok: true, status: 200, body: snapshot };
}

module.exports = { handleCreate, handlePatch, handleGet, serializeMask };
