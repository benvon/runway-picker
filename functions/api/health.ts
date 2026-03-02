export const onRequestGet: PagesFunction = async () => {
  return Response.json({
    status: 'ok',
    service: 'runway-picker',
    timestamp: new Date().toISOString()
  });
};
