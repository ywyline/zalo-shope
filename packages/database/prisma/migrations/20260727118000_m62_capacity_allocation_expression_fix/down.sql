-- LOCAL/TEST ONLY. Restore the preceding function definition only when no
-- M6 business facts exist. Production uses forward repair.
SELECT "app_security"."assert_m62_rollback_safe"();

CREATE OR REPLACE FUNCTION "app_security"."validate_m62_order_allocation"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE sale_record record;
DECLARE order_record record;
BEGIN
  IF pg_catalog.current_setting('app.actor_type', true) <> 'admin'
     OR NEW.store_id IS DISTINCT FROM app_security.current_store_id()
     OR NOT EXISTS (
       SELECT 1 FROM public.admin_users admin
       WHERE admin.id = app_security.current_actor_id()
     )
  THEN
    RAISE EXCEPTION 'after-sale order allocation requires the current administrator'
      USING ERRCODE = '42501';
  END IF;

  SELECT sale.status, sale.legacy_policy_review, sale.review_resume_status,
    sale.approved_shipping_vnd, sale.approved_other_vnd
  INTO sale_record
  FROM public.after_sales sale
  WHERE sale.store_id = NEW.store_id
    AND sale.id = NEW.after_sale_id
    AND sale.order_id = NEW.order_id
  FOR UPDATE;
  IF NOT FOUND
     OR NOT (sale_record.status = 'PENDING_REVIEW'
       OR (sale_record.status = 'REVIEW_REQUIRED'
         AND sale_record.legacy_policy_review
         AND sale_record.review_resume_status IS NULL))
     OR NEW.shipping_fee_vnd + NEW.remote_surcharge_vnd
       <> sale_record.approved_shipping_vnd
     OR NEW.other_vnd <> sale_record.approved_other_vnd
  THEN
    RAISE EXCEPTION 'order allocation must exactly match the pending after-sale approval'
      USING ERRCODE = '23514';
  END IF;

  SELECT orders.shipping_fee_vnd, orders.remote_surcharge_vnd,
    orders.shipping_discount_vnd
  INTO order_record
  FROM public.orders orders
  WHERE orders.store_id = NEW.store_id AND orders.id = NEW.order_id
  FOR UPDATE;
  IF NOT FOUND
     OR NEW.shipping_fee_vnd > order_record.shipping_fee_vnd
     OR NEW.remote_surcharge_vnd > order_record.remote_surcharge_vnd
     OR NEW.shipping_fee_vnd + NEW.remote_surcharge_vnd
       > pg_catalog.greatest(
         order_record.shipping_fee_vnd + order_record.remote_surcharge_vnd
           - order_record.shipping_discount_vnd,
         0::bigint
       )
  THEN
    RAISE EXCEPTION 'order allocation exceeds the paid shipping entitlement'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION "app_security"."validate_m62_order_allocation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_security"."validate_m62_order_allocation"()
FROM zalo_shop_runtime;
