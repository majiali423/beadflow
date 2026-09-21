-- Remove obsolete generated-pattern caps from databases that already applied the
-- early migrations. Historical rows are preserved for audit and export.

alter table if exists public.projects
  drop constraint if exists projects_board_width_check,
  drop constraint if exists projects_board_height_check;

alter table if exists public.projects
  add constraint projects_board_width_positive check (board_width > 0),
  add constraint projects_board_height_positive check (board_height > 0);

alter table if exists public.pattern_versions
  drop constraint if exists pattern_versions_width_check,
  drop constraint if exists pattern_versions_height_check;

alter table if exists public.pattern_versions
  add constraint pattern_versions_width_positive check (width > 0),
  add constraint pattern_versions_height_positive check (height > 0);

alter table if exists public.scan_jobs
  drop constraint if exists scan_jobs_grid_width_check,
  drop constraint if exists scan_jobs_grid_height_check;

alter table if exists public.scan_jobs
  add constraint scan_jobs_grid_width_positive check (grid_width > 0),
  add constraint scan_jobs_grid_height_positive check (grid_height > 0);

alter table if exists public.build_steps
  drop constraint if exists build_steps_palette_color_ids_check;

alter table if exists public.build_steps
  add constraint build_steps_palette_color_ids_nonempty
    check (cardinality(palette_color_ids) > 0);
