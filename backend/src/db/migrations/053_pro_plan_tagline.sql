-- The «Мережа» plan promised «Від 5 до 150 точок» in its tagline while
-- plan_limits.max_sites for the same plan says 100 — and the landing renders
-- both on one card from GET /api/public/plans, so the contradiction was public.
-- The limit is the enforced fact; the tagline names the audience, the way the
-- other plans' taglines do («Аптека, кафе, магазин», «Сервісна компанія»).
-- Only the untouched default is rewritten: a tagline someone edited stays.
UPDATE plan_limits SET tagline = 'Мережі магазинів і HoReCa'
 WHERE plan = 'pro' AND tagline = 'Від 5 до 150 точок';
