-- The previous migration copied every chunk's terms into the full-text index.
DROP TABLE "document_terms";
