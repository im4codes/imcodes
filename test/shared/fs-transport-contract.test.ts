import { describe, it, expectTypeOf } from 'vitest';
import type {
  FsEntry as SharedFsEntry,
  GitStatusEntry as SharedGitStatusEntry,
  FsLsResponse as SharedFsLsResponse,
  FsReadResponse as SharedFsReadResponse,
  FsGitStatusResponse as SharedFsGitStatusResponse,
  FsGitDiffResponse as SharedFsGitDiffResponse,
} from '../../src/shared/transport/fs.js';
import type {
  FsEntry as WebFsEntry,
  GitStatusEntry as WebGitStatusEntry,
  FsLsResponse as WebFsLsResponse,
  FsReadResponse as WebFsReadResponse,
  FsGitStatusResponse as WebFsGitStatusResponse,
  FsGitDiffResponse as WebFsGitDiffResponse,
} from '../../web/src/ws-client.js';

describe('shared fs transport contract', () => {
  it('web fs entry types match shared contract', () => {
    expectTypeOf<WebFsEntry>().toEqualTypeOf<SharedFsEntry>();
    expectTypeOf<WebGitStatusEntry>().toEqualTypeOf<SharedGitStatusEntry>();
  });

  it('web fs response types match shared contract', () => {
    expectTypeOf<WebFsLsResponse>().toEqualTypeOf<SharedFsLsResponse>();
    expectTypeOf<WebFsReadResponse>().toEqualTypeOf<SharedFsReadResponse>();
    expectTypeOf<WebFsGitStatusResponse>().toEqualTypeOf<SharedFsGitStatusResponse>();
    expectTypeOf<WebFsGitDiffResponse>().toEqualTypeOf<SharedFsGitDiffResponse>();
  });
});
