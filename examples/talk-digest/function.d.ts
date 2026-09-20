declare const handler: {
  fetch(request: Request, props: { token: string; runId: string; workspaceId: string }): Promise<Response>;
};
export default handler;
