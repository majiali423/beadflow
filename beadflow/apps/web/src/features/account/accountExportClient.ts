import type { PersonalDataExport } from '@beadflow/shared-types';

type ApiErrorPayload = { error?: { message?: string } };

export async function loadPersonalDataExport(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<PersonalDataExport> {
  const response = await fetcher('/api/account/export', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json()) as PersonalDataExport | ApiErrorPayload;
  if (!response.ok) {
    throw new Error((payload as ApiErrorPayload).error?.message ?? '个人数据导出失败。');
  }
  return payload as PersonalDataExport;
}

export function downloadPersonalDataExport(payload: PersonalDataExport): void {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `BeadFlow-个人数据-${payload.generatedAt.slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
