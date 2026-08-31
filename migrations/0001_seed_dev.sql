INSERT INTO ngo (id, name, slug, status) VALUES ('n1', 'Refugio Patitas', 'patitas', 'pending');
INSERT INTO goal (id, ngo_id, title, description, target_amount_cents, created_at)
  VALUES ('g1', 'n1', 'Campaña de castración', 'Castrar 50 gatos comunitarios.', 100000000, '2026-08-31T00:00:00Z');
INSERT INTO contribution (id, goal_id, source, mp_payment_id, amount_cents, status, paid_at, note, created_at)
  VALUES ('c1', 'g1', 'manual', NULL, 25000000, 'approved', '2026-08-31T00:00:00Z', 'Transferencias por alias', '2026-08-31T00:00:00Z');
