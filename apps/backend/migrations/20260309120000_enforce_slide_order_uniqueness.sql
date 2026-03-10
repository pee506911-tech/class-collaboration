DROP TEMPORARY TABLE IF EXISTS tmp_slide_order;

CREATE TEMPORARY TABLE tmp_slide_order (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    new_order_index INT NOT NULL
);

INSERT INTO tmp_slide_order (id, new_order_index)
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
