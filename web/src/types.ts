export type Credentials = {
  baseUrl: string;
  username: string;
  appPassword: string;
  calendarHref?: string;
};

export type CalendarInfo = {
  href: string;
  displayName: string;
};

export type Task = {
  uid: string;
  summary: string;
  status: string;
  categories: string[];
};
