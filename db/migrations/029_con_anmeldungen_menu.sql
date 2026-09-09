UPDATE groups SET visible_menus = visible_menus || '["con-anmeldungen"]'::jsonb
WHERE NOT (visible_menus @> '["con-anmeldungen"]'::jsonb);
