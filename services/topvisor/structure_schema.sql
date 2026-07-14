-- services/topvisor/structure_schema.sql
-- Справочник структуры TopVisor: проекты -> группы -> ключевые фразы (с целевыми ссылками)
-- Заполняется отдельным скриптом scripts/sync-topvisor-structure.js

CREATE SCHEMA IF NOT EXISTS topvisor;

CREATE TABLE IF NOT EXISTS topvisor.dim_projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS topvisor.dim_groups (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES topvisor.dim_projects(id),
    folder_id INTEGER,
    name TEXT NOT NULL,
    is_on BOOLEAN,
    count_keywords INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS topvisor.dim_keywords (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES topvisor.dim_projects(id),
    group_id INTEGER REFERENCES topvisor.dim_groups(id),
    name TEXT NOT NULL,
    target TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dim_groups_project ON topvisor.dim_groups(project_id);
CREATE INDEX IF NOT EXISTS idx_dim_keywords_project ON topvisor.dim_keywords(project_id);
CREATE INDEX IF NOT EXISTS idx_dim_keywords_group ON topvisor.dim_keywords(group_id);

COMMENT ON TABLE topvisor.dim_projects IS 'Справочник проектов TopVisor (get/projects_2/projects)';
COMMENT ON TABLE topvisor.dim_groups IS 'Справочник групп ключевых фраз TopVisor (get/keywords_2/groups)';
COMMENT ON TABLE topvisor.dim_keywords IS 'Справочник ключевых фраз TopVisor с целевыми ссылками (get/keywords_2/keywords, поле target)';
