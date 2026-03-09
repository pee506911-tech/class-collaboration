CREATE TEMPORARY TABLE tmp_slide_order AS
SELECT
    id,
    ROW_NUMBER() OVER (
        PARTITION BY session_id
        ORDER BY order_index, id
    ) - 1 AS new_order_index
FROM slides;

UPDATE slides s
JOIN tmp_slide_order o ON o.id = s.id
SET s.order_index = o.new_order_index;

DROP TEMPORARY TABLE tmp_slide_order;

ALTER TABLE slides
    ADD UNIQUE INDEX uq_slides_session_order_index (session_id, order_index);
