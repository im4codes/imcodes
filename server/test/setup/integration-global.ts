/**
 * Vitest globalSetup for integration tests.
 *
 * Starts a PostgreSQL container once before all integration test files,
 * exposes the connection URL via environment variable, and stops the
 * container after all tests complete.
 *
 * Pool lifecycle (open / close) is handled per test file in beforeAll/afterAll.
 */

import { PostgreSqlContainer } from '@testcontainers/postgresql';

export async function setup() {
  // Use AWS ECR public mirror to avoid Docker Hub rate limits in CI
  const container = await new PostgreSqlContainer('public.ecr.aws/docker/library/postgres:16-alpine').start();
  process.env.TEST_DATABASE_URL = container.getConnectionUri();

  return async function teardown() {
    await container.stop();
  };
}
