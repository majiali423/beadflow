import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parsePalette } from '@beadflow/palette-engine';

const sourcePath = resolve('assets/palettes/mard221.json');
const migrationPath = resolve('supabase/migrations/202607200002_mard221_palette.sql');

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildMigration(source: string): string {
  const report = parsePalette(source, 221);
  const { palette } = report;
  const checksum = createHash('sha256').update(source).digest('hex').toUpperCase();

  const colorRows = palette.colors
    .map(
      (color) =>
        `  (${[
          sqlString(color.id),
          sqlString(color.paletteId),
          sqlString(color.code),
          color.name ? sqlString(color.name) : 'null',
          sqlString(color.hex),
          `${sqlString(JSON.stringify(color.rgb))}::jsonb`,
          `${sqlString(JSON.stringify(color.lab))}::jsonb`,
          color.isActive ? 'true' : 'false',
        ].join(', ')})`,
    )
    .join(',\n');

  return `-- Generated only from assets/palettes/mard221.json.
-- Source SHA256: ${checksum}
-- Do not hand-edit color IDs, codes, HEX, RGB, or Lab values.

begin;

insert into public.palettes (id, name, version)
values (${sqlString(palette.id)}, ${sqlString(palette.name)}, ${sqlString(palette.version)})
on conflict (id) do update
set
  name = excluded.name,
  version = excluded.version;

insert into public.palette_colors (
  id,
  palette_id,
  code,
  name,
  hex,
  rgb,
  lab,
  is_active
)
values
${colorRows}
on conflict (id) do update
set
  palette_id = excluded.palette_id,
  code = excluded.code,
  name = excluded.name,
  hex = excluded.hex,
  rgb = excluded.rgb,
  lab = excluded.lab,
  is_active = excluded.is_active;

do $$
declare
  v_color_count integer;
begin
  select count(*)
  into v_color_count
  from public.palette_colors
  where palette_id = ${sqlString(palette.id)};

  if v_color_count <> 221 then
    raise exception 'MARD_221_COLOR_COUNT_MISMATCH: expected 221, actual %', v_color_count;
  end if;
end;
$$;

commit;
`;
}

async function main() {
  const source = await readFile(sourcePath, 'utf8');
  const expected = buildMigration(source);

  if (process.argv.includes('--check')) {
    const current = await readFile(migrationPath, 'utf8');
    if (current !== expected) {
      throw new Error('MARD 221 migration is stale or differs from the verified palette source.');
    }
    console.log('MARD 221 migration matches the verified 221-color source exactly.');
  } else {
    await writeFile(migrationPath, expected, 'utf8');
    console.log(`Generated ${migrationPath} from the verified 221-color palette.`);
  }
}

void main();
