import { Issue } from '@linear/sdk';

declare module '@linear/sdk' {
  interface LinearClient {
    issueUpdate(
      id: string,
      input: {
        priority?: number;
        [key: string]: any;
      }
    ): Promise<Issue>;
  }
}