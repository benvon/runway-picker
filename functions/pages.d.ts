type PagesFunction<Env = unknown, Params extends string = string, Data = unknown> = (context: {
  request: Request;
  env: Env;
  params: Record<Params, string>;
  data: Data;
  waitUntil: (promise: Promise<unknown>) => void;
  next: () => Promise<Response>;
}) => Response | Promise<Response>;
