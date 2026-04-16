import { describe, expect, it } from 'vitest';
import { cosineSimilarity, EMBEDDING_DIM, generateEmbedding, isEmbeddingAvailable } from '../../src/context/embedding.js';

const RUN_REAL = process.env.RUN_REAL_EMBEDDING_TESTS === '1';
const describeReal = RUN_REAL ? describe : describe.skip;

async function expectRelatedBeatsUnrelated(queryText: string, relatedText: string, unrelatedText: string): Promise<void> {
  const query = await generateEmbedding(queryText);
  const related = await generateEmbedding(relatedText);
  const unrelated = await generateEmbedding(unrelatedText);

  expect(query).toBeTruthy();
  expect(related).toBeTruthy();
  expect(unrelated).toBeTruthy();

  const relatedScore = cosineSimilarity(query!, related!);
  const unrelatedScore = cosineSimilarity(query!, unrelated!);

  expect(relatedScore).toBeGreaterThan(unrelatedScore);
}

describeReal('real multilingual embedding integration', () => {
  it('loads the real transformers.js model and emits 384-dim vectors', async () => {
    const available = await isEmbeddingAvailable();
    expect(available).toBe(true);

    const embedding = await generateEmbedding('fix garbled download filename');
    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding?.length).toBe(EMBEDDING_DIM);
  }, 120000);

  it('matches English query to Chinese text better than unrelated text', async () => {
    await expectRelatedBeatsUnrelated(
      'fix garbled download filename',
      '修复下载文件名乱码问题',
      '今天天气很好，适合出去散步',
    );
  }, 120000);

  it('matches Chinese query to English text better than unrelated text', async () => {
    await expectRelatedBeatsUnrelated(
      '修复会话恢复时的 websocket 重连竞争',
      'Resolved WebSocket reconnect race during session restore',
      'A recipe for tomato pasta with basil',
    );
  }, 120000);

  it('matches Spanish query to Chinese text better than unrelated text', async () => {
    await expectRelatedBeatsUnrelated(
      'corregir el nombre del archivo descargado con caracteres dañados',
      '修复下载文件名乱码问题',
      'La receta perfecta para hacer tortilla de patatas',
    );
  }, 120000);

  it('matches Japanese query to English text better than unrelated text', async () => {
    await expectRelatedBeatsUnrelated(
      'セッション復元時のWebSocket再接続競合を修正',
      'Resolved WebSocket reconnect race during session restore',
      'Best places to see autumn leaves in Kyoto',
    );
  }, 120000);

  it('matches Korean query to Russian text better than unrelated text', async () => {
    await expectRelatedBeatsUnrelated(
      '다운로드 파일명 깨짐 문제 수정',
      'исправить проблему с поврежденным именем загружаемого файла',
      'Как приготовить борщ дома',
    );
  }, 120000);
});
