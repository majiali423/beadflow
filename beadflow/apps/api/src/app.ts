import Fastify, { type FastifyInstance } from 'fastify';

import {
  registerPersonalDataExportRoutes,
  type PersonalDataExportRoutesOptions,
} from './dataExport.js';
import { registerInventoryRoutes, type InventoryRoutesOptions } from './inventory.js';
import {
  registerPatternCardReviewRoutes,
  type PatternCardReviewRoutesOptions,
} from './patternCardReviews.js';
import {
  registerPatternCardUploadRoutes,
  type PatternCardUploadRoutesOptions,
} from './patternCardUploads.js';

type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
};

type ServiceError = Error & {
  code?: string;
  statusCode?: number;
};

export type BuildAppOptions = {
  dataExport?: PersonalDataExportRoutesOptions;
  inventory?: InventoryRoutesOptions;
  patternCardReviews?: PatternCardReviewRoutesOptions;
  patternCardUploads?: PatternCardUploadRoutesOptions;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });

  app.addContentTypeParser(
    /^image\/(jpeg|png|webp)$/,
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.get('/health', async () => ({
    status: 'ok',
    service: 'beadflow-api',
  }));

  registerPersonalDataExportRoutes(
    app,
    options.dataExport ?? {
      repository: null,
    },
  );

  registerInventoryRoutes(
    app,
    options.inventory ?? {
      validPaletteColorIds: new Set(),
      repository: null,
    },
  );

  registerPatternCardReviewRoutes(
    app,
    options.patternCardReviews ?? {
      validPaletteColorIds: new Set(),
      paletteColors: [],
      inventoryRepository: null,
      repository: null,
    },
  );

  registerPatternCardUploadRoutes(
    app,
    options.patternCardUploads ?? {
      paletteColors: [],
      repository: null,
      cvClient: null,
    },
  );

  app.setNotFoundHandler(async (request, reply): Promise<ErrorEnvelope> => {
    reply.status(404);
    return {
      error: {
        code: 'NOT_FOUND',
        message: '请求的资源不存在。',
        requestId: request.id,
      },
    };
  });

  app.setErrorHandler(async (error, request, reply): Promise<ErrorEnvelope> => {
    const serviceError: ServiceError =
      error instanceof Error ? (error as ServiceError) : new Error('Unknown service error');
    const statusCode = serviceError.statusCode ?? 500;

    request.log.error(serviceError);
    reply.status(statusCode);
    return {
      error: {
        code: serviceError.code ?? 'INTERNAL_ERROR',
        message: statusCode < 500 ? serviceError.message : '服务暂时不可用。',
        requestId: request.id,
      },
    };
  });

  return app;
}
