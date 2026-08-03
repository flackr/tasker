export type Credentials = {
  baseUrl: string;
  username: string;
  appPassword: string;
};

export type Task = {
  uid: string;
  summary: string;
  status: string;
  categories: string[];
};
