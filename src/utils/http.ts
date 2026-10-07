import type { Response } from "express";

export interface PageMeta {
  page: number;
  pageSize: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** `{ success: true, data, message? }` */
export function ok<T>(res: Response, data: T, message?: string, status = 200) {
  return res.status(status).json(message ? { success: true, data, message } : { success: true, data });
}

export function created<T>(res: Response, data: T, message?: string) {
  return ok(res, data, message, 201);
}

export function noContent(res: Response) {
  return res.status(204).end();
}

/** `{ success: true, data: [...], meta: { page, pageSize, limit, total, totalPages } }` */
export function paginated<T>(res: Response, items: T[], meta: { page: number; pageSize: number; total: number }) {
  const body: { success: true; data: T[]; meta: PageMeta } = {
    success: true,
    data: items,
    meta: {
      page: meta.page,
      pageSize: meta.pageSize,
      limit: meta.pageSize,
      total: meta.total,
      totalPages: Math.max(1, Math.ceil(meta.total / Math.max(1, meta.pageSize))),
    },
  };
  return res.status(200).json(body);
}
