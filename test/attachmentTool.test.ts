import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DocumentAttachment, PhotoAttachment } from 'vk-io';
import type { AttachmentRef } from '../src/services/ai/tools/attachmentTool.js';

process.env.VK_TOKEN = 'test-token';
process.env.VK_GROUP_ID = '1';
process.env.OPENAI_API_KEY = 'test-key';
process.env.LOG_LEVEL = 'silent';

const { createAttachmentTool } = await import('../src/services/ai/tools/attachmentTool.js');

const photo = {} as PhotoAttachment;
const document = { extension: 'pdf', title: 'report.pdf' } as DocumentAttachment;
const imageDocument = { extension: 'png', title: 'drawing.png' } as DocumentAttachment;

type ToolOptions = {
  allowed?: boolean;
  attachment?: AttachmentRef;
  imageError?: Error;
  documentError?: Error;
};

function attachmentTool(options: ToolOptions = {}) {
  const usage: string[] = [];
  const imagePrompts: string[] = [];
  const imageDocumentPrompts: string[] = [];
  const documentPrompts: string[] = [];
  let attachmentRequests = 0;
  const tool = createAttachmentTool({
    senderId: '1',
    peerId: 2_000_000_001,
    checkAccess: async () =>
      options.allowed === false
        ? { allowed: false, message: 'Нет доступа.' }
        : { allowed: true, isAdmin: true },
    getAttachment: async () => {
      attachmentRequests += 1;
      return options.attachment;
    },
    analyzeImage: async (_photo, prompt) => {
      imagePrompts.push(prompt);
      if (options.imageError) throw options.imageError;
      return 'image analysis';
    },
    analyzeImageDocument: async (_document, prompt) => {
      imageDocumentPrompts.push(prompt);
      if (options.imageError) throw options.imageError;
      return 'image document analysis';
    },
    analyzeDocument: async (_document, prompt) => {
      documentPrompts.push(prompt);
      if (options.documentError) throw options.documentError;
      return 'document analysis';
    },
    recordUsage: async (feature) => {
      usage.push(feature);
    },
  });
  return {
    tool,
    usage,
    imagePrompts,
    imageDocumentPrompts,
    documentPrompts,
    attachmentRequests: () => attachmentRequests,
  };
}

test('analyze_attachment analyzes a photo from the current message or reply', async () => {
  const { tool, usage, imagePrompts } = attachmentTool({
    attachment: { kind: 'photo', photo },
  });
  const result = JSON.parse(await tool.execute({ prompt: 'Опиши изображение' }));
  assert.equal(result.status, 'result');
  assert.equal(result.kind, 'photo');
  assert.equal(result.message, 'image analysis');
  assert.deepEqual(usage, ['analyze']);
  assert.deepEqual(imagePrompts, ['Опиши изображение']);
});

test('analyze_attachment analyzes a document that is an image', async () => {
  const { tool, usage, imageDocumentPrompts } = attachmentTool({
    attachment: { kind: 'image_document', document: imageDocument },
  });
  const result = JSON.parse(await tool.execute({ prompt: 'Распознай текст' }));
  assert.equal(result.status, 'result');
  assert.equal(result.kind, 'image_document');
  assert.deepEqual(usage, ['analyze']);
  assert.deepEqual(imageDocumentPrompts, ['Распознай текст']);
});

test('analyze_attachment analyzes a supported document', async () => {
  const { tool, usage, documentPrompts } = attachmentTool({
    attachment: { kind: 'document', document },
  });
  const result = JSON.parse(await tool.execute({ prompt: 'Кратко изложи документ' }));
  assert.equal(result.status, 'result');
  assert.equal(result.kind, 'document');
  assert.deepEqual(usage, ['document_analysis']);
  assert.deepEqual(documentPrompts, ['Кратко изложи документ']);
});

test('analyze_attachment asks for a file when there is no attachment', async () => {
  const { tool, usage } = attachmentTool();
  const result = JSON.parse(await tool.execute({ prompt: 'Опиши файл' }));
  assert.equal(result.status, 'needs_attachment');
  assert.deepEqual(usage, []);
});

test('analyze_attachment rejects unsupported document formats', async () => {
  const { tool, usage } = attachmentTool({
    attachment: { kind: 'unsupported', document: { extension: 'exe' } as DocumentAttachment },
  });
  const result = JSON.parse(await tool.execute({ prompt: 'Опиши файл' }));
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(usage, []);
});

test('analyze_attachment respects access before loading an attachment', async () => {
  const { tool, attachmentRequests } = attachmentTool({ allowed: false });
  const result = JSON.parse(await tool.execute({ prompt: 'Опиши файл' }));
  assert.equal(result.status, 'not_allowed');
  assert.equal(attachmentRequests(), 0);
});

test('analyze_attachment reports analysis errors without recording usage', async () => {
  const { tool, usage } = attachmentTool({
    attachment: { kind: 'photo', photo },
    imageError: new Error('provider failed'),
  });
  const result = JSON.parse(await tool.execute({ prompt: 'Опиши файл' }));
  assert.equal(result.status, 'error');
  assert.deepEqual(usage, []);
});

test('analyze_attachment runs at most once per AI response', async () => {
  const { tool, usage } = attachmentTool({
    attachment: { kind: 'photo', photo },
  });
  const first = JSON.parse(await tool.execute({ prompt: 'Опиши файл' }));
  const second = JSON.parse(await tool.execute({ prompt: 'Опиши ещё раз' }));
  assert.equal(first.status, 'result');
  assert.equal(second.status, 'not_executed');
  assert.deepEqual(usage, ['analyze']);
});

test('analyze_attachment validates the prompt', async () => {
  const { tool } = attachmentTool({ attachment: { kind: 'photo', photo } });
  const missing = JSON.parse(await tool.execute({}));
  const tooLong = JSON.parse(await tool.execute({ prompt: 'а'.repeat(4001) }));
  const extra = JSON.parse(await tool.execute({ prompt: 'Опиши', extra: true }));
  assert.equal(missing.status, 'not_executed');
  assert.equal(tooLong.status, 'not_executed');
  assert.equal(extra.status, 'not_executed');
});
