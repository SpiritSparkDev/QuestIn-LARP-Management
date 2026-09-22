UPDATE groups SET visible_menus = visible_menus || '["dateien"]'::jsonb
WHERE NOT (visible_menus @> '["dateien"]'::jsonb);
