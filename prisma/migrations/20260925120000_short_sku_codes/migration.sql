-- Short SKUs (PRD §4.2, P3.1 follow-up): SKU = product code + size code +
-- colour code, at most 9 capital letters/digits, so every price tag's
-- Code 128 barcode prints with 2-dot (0.25 mm) bars on a 38 mm label at
-- 203 dpi — the width that survives a thermal head's ink spread.

-- 1. Size and colour codes. Added empty, backfilled, then required.
ALTER TABLE "sizes" ADD COLUMN "code" TEXT;
ALTER TABLE "colors" ADD COLUMN "code" TEXT;

UPDATE "sizes" SET "code" = CASE upper("name")
    WHEN 'FREE' THEN 'F' WHEN 'FREE SIZE' THEN 'F'
    ELSE upper(regexp_replace("name", '[^A-Za-z0-9]', '', 'g')) END;
-- Anything still too long or empty (a size added by hand): Z1, Z2, ...
UPDATE "sizes" s SET "code" = 'Z' || n.rn
  FROM (SELECT "id", row_number() OVER (ORDER BY "sortOrder", "name") AS rn FROM "sizes" WHERE "code" !~ '^[A-Z0-9]{1,3}$') n
 WHERE s."id" = n."id";

UPDATE "colors" SET "code" = CASE "name"
    WHEN 'Black' THEN 'BLK' WHEN 'White' THEN 'WHT' WHEN 'Maroon' THEN 'MRN' WHEN 'Navy Blue' THEN 'NBL'
    WHEN 'Red' THEN 'RD' WHEN 'Mustard Yellow' THEN 'MYL' WHEN 'Pink' THEN 'PNK' WHEN 'Emerald Green' THEN 'EGR'
    END;
-- Colours added by hand get C01, C02, ... — edit them in the colour master before printing tags.
UPDATE "colors" c SET "code" = 'C' || lpad(n.rn::text, 2, '0')
  FROM (SELECT "id", row_number() OVER (ORDER BY "sortOrder", "name") AS rn FROM "colors" WHERE "code" IS NULL) n
 WHERE c."id" = n."id";

ALTER TABLE "sizes" ALTER COLUMN "code" SET NOT NULL;
ALTER TABLE "colors" ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "sizes_code_key" ON "sizes"("code");
CREATE UNIQUE INDEX "colors_code_key" ON "colors"("code");
ALTER TABLE "sizes" ADD CONSTRAINT "sizes_code_chk" CHECK ("code" ~ '^[A-Z0-9]{1,3}$');
ALTER TABLE "colors" ADD CONSTRAINT "colors_code_chk" CHECK ("code" ~ '^[A-Z0-9]{2,3}$');

-- 2. Product codes: 2–3 characters.
UPDATE "products" SET "code" = CASE "code"
    WHEN 'SAREE01' THEN 'S01' WHEN 'KURTI12' THEN 'K12' WHEN '3PC05' THEN '3P5' WHEN 'WEST02' THEN 'W02'
    ELSE "code" END;
-- Any other long code: its first letter + a 2-digit number (P01, K02, ...).
UPDATE "products" p SET "code" = n.letter || lpad(n.rn::text, 2, '0')
  FROM (
    SELECT "id",
           coalesce(nullif(left(upper(regexp_replace("code", '[^A-Za-z]', '', 'g')), 1), ''), 'P') AS letter,
           row_number() OVER (PARTITION BY left(upper(regexp_replace("code", '[^A-Za-z]', '', 'g')), 1) ORDER BY "createdAt") + 20 AS rn
      FROM "products" WHERE "code" !~ '^[A-Z0-9]{2,3}$'
  ) n
 WHERE p."id" = n."id";
ALTER TABLE "products" ADD CONSTRAINT "products_code_chk" CHECK ("code" ~ '^[A-Z0-9]{2,3}$');

-- 3. Regenerate every SKU (no tag has been printed yet) and hold them to the form.
ALTER TABLE "product_variants" ADD COLUMN "tagPrintedAt" TIMESTAMP(3);
UPDATE "product_variants" v
   SET "sku" = p."code" || s."code" || c."code", "skuLocked" = false
  FROM "products" p, "sizes" s, "colors" c
 WHERE p."id" = v."productId" AND s."id" = v."sizeId" AND c."id" = v."colorId";
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_sku_chk" CHECK ("sku" ~ '^[A-Z0-9]{1,9}$');
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_sku_locked_chk" CHECK ("skuLocked" = ("tagPrintedAt" IS NOT NULL));

-- 4. Once a tag is printed, the SKU on it is the variant's for good.
CREATE FUNCTION "product_variants_sku_lock"() RETURNS trigger AS $$
BEGIN
  IF OLD."tagPrintedAt" IS NOT NULL THEN
    IF NEW."sku" IS DISTINCT FROM OLD."sku" THEN
      RAISE EXCEPTION 'SKU % is locked: a price tag has already been printed for it', OLD."sku"
        USING ERRCODE = '23514', HINT = 'A printed tag carries this SKU. Create a new variant instead.';
    END IF;
    IF NEW."tagPrintedAt" IS NULL THEN
      RAISE EXCEPTION 'The tag-printed mark on SKU % can''t be cleared', OLD."sku" USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "product_variants_sku_lock"
  BEFORE UPDATE ON "product_variants"
  FOR EACH ROW EXECUTE FUNCTION "product_variants_sku_lock"();
