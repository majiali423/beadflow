import type { PersonalDataExport } from '@beadflow/shared-types';
import type { FastifyInstance } from 'fastify';

export interface PersonalDataExportRepository {
  exportData(accessToken: string): Promise<PersonalDataExport>;
}

export type PersonalDataExportRoutesOptions = {
  repository: PersonalDataExportRepository | null;
};

export class PersonalDataExportError extends Error {
  constructor(message = '个人数据导出失败。') {
    super(message);
    this.name = 'PersonalDataExportError';
  }
}

function bearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export function registerPersonalDataExportRoutes(
  app: FastifyInstance,
  options: PersonalDataExportRoutesOptions,
): void {
  app.get('/api/account/export', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken) {
      return reply.status(401).send({
        error: {
          code: 'AUTH_REQUIRED',
          message: '导出个人数据前必须登录。',
          requestId: request.id,
        },
      });
    }
    if (!options.repository) {
      return reply.status(503).send({
        error: {
          code: 'DATA_EXPORT_NOT_CONFIGURED',
          message: '个人数据导出服务尚未配置。',
          requestId: request.id,
        },
      });
    }

    try {
      const payload = await options.repository.exportData(accessToken);
      return reply
        .header(
          'content-disposition',
          `attachment; filename="beadflow-personal-data-${payload.generatedAt.slice(0, 10)}.json"`,
        )
        .send(payload);
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'DATA_EXPORT_FAILED',
          message: '个人数据导出失败，没有修改任何账号、图纸或库存数据。',
          requestId: request.id,
        },
      });
    }
  });
}

export class SupabasePersonalDataExportRepository implements PersonalDataExportRepository {
  constructor(
    private readonly url: string,
    private readonly publishableKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async exportData(accessToken: string): Promise<PersonalDataExport> {
    const response = await this.fetcher(`${this.url}/rest/v1/rpc/export_my_beadflow_data`, {
      method: 'POST',
      headers: {
        apikey: this.publishableKey,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    const payload = (await response.json()) as PersonalDataExport | { message?: string };
    if (!response.ok || !('schemaVersion' in payload)) {
      throw new PersonalDataExportError((payload as { message?: string }).message);
    }
    return payload;
  }
}
