import { describe, expect, it } from 'vitest';

import {
  buildP2pExecutionMarker,
  stringifyP2pExecutionMarker,
  validateP2pExecutionMarkerContent,
  type P2pExecutionMarkerSpec,
} from '../../shared/p2p-execution-marker.js';

const spec: P2pExecutionMarkerSpec = {
  runId: 'run_123',
  cycleIndex: 2,
  cycleTotal: 3,
  nonce: 'nonce_abc',
};

describe('p2p execution marker', () => {
  it('accepts an exact completed marker for the expected run and cycle', () => {
    const content = stringifyP2pExecutionMarker(buildP2pExecutionMarker(spec, 'completed'));

    expect(validateP2pExecutionMarkerContent(content, spec)).toMatchObject({
      ok: true,
      marker: {
        runId: 'run_123',
        cycleIndex: 2,
        cycleTotal: 3,
        nonce: 'nonce_abc',
        status: 'completed',
      },
    });
  });

  it('rejects mismatched nonce and does not treat it as agent failure', () => {
    const content = stringifyP2pExecutionMarker(buildP2pExecutionMarker({ ...spec, nonce: 'wrong' }, 'completed'));

    expect(validateP2pExecutionMarkerContent(content, spec)).toMatchObject({
      ok: false,
      reason: 'nonce_mismatch',
    });
  });

  it('surfaces a matching failed marker as an agent-reported failure', () => {
    const content = stringifyP2pExecutionMarker({
      ...buildP2pExecutionMarker(spec, 'failed'),
      error: 'tests failed',
    });

    expect(validateP2pExecutionMarkerContent(content, spec)).toMatchObject({
      ok: false,
      reason: 'tests failed',
      failedByAgent: true,
    });
  });
});
