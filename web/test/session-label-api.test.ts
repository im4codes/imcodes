import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();

vi.mock('../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

describe('updateMainSessionLabel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists a label update via the main-session label route with keepalive enabled', async () => {
    const { updateMainSessionLabel } = await import('../src/session-label-api.js');

    await updateMainSessionLabel('srv-1', 'deck_proj_brain', 'Readable Main');

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/server/srv-1/sessions/deck_proj_brain/label',
      {
        method: 'PATCH',
        keepalive: true,
        body: JSON.stringify({ label: 'Readable Main' }),
      },
    );
  });

  it('persists label clearing as null', async () => {
    const { updateMainSessionLabel } = await import('../src/session-label-api.js');

    await updateMainSessionLabel('srv-1', 'deck_proj_brain', null);

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/server/srv-1/sessions/deck_proj_brain/label',
      {
        method: 'PATCH',
        keepalive: true,
        body: JSON.stringify({ label: null }),
      },
    );
  });
});
