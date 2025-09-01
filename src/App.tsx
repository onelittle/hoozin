import { Temporal } from "temporal-polyfill";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import "./App.css";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  hd: string;
  scope: string;
}

interface GooglePerson {
  emailAddresses?: { value: string; metadata?: { primary: boolean } }[];
  names?: { displayName: string; metadata?: { primary: boolean } }[];
}

type GoogleCalendarEvent =
  | {
      eventType: "workingLocation";
      start: { date: string };
      end: { date: string };
      workingLocationProperties: {
        type: "officeLocation" | "homeOffice";
      };
    }
  | {
      eventType: "outOfOffice";
      start: { dateTime: string };
      end: { dateTime: string };
    }
  | {
      summary: string;
      eventType: "default";
      start: { dateTime: string };
      end: { dateTime: string };
    };

type State = {
  people: string[];
  ignorePeople: string[];
  events: {
    date: string;
    personEmail: string;
    status: "homeOffice" | "officeLocation" | "unknown";
  }[];
};

type Action =
  | {
      type: "ADD_PERSON_EVENT";
      email: string;
      calendarEvent: GoogleCalendarEvent;
    }
  | {
      type: "DISCOVERED_PERSON";
      email: string;
    };

function stateReducer(currentState: State, action: Action): State {
  switch (action.type) {
    case "ADD_PERSON_EVENT": {
      const newEvents = [...currentState.events];
      const { email, calendarEvent } = action;
      if (calendarEvent.eventType === "workingLocation") {
        const { start, end, workingLocationProperties } = calendarEvent;
        let currentDate = Temporal.PlainDate.from(start.date);
        const endDate = Temporal.PlainDate.from(end.date);
        while (Temporal.PlainDate.compare(currentDate, endDate) < 0) {
          const dateString = currentDate.toString();
          let stateEntry = newEvents.find(
            (entry) => entry.date === dateString && entry.personEmail === email
          );
          const status = workingLocationProperties.type ?? "unknown";
          if (stateEntry) {
            stateEntry.status = status;
          } else {
            stateEntry = { date: dateString, personEmail: email, status };
            newEvents.push(stateEntry);
          }
          currentDate = currentDate.add({ days: 1 });
        }
        return {
          events: newEvents,
          ignorePeople: currentState.ignorePeople,
          people: currentState.people,
        };
      } else {
        // TODO: Fetch and handle outOfOffice events
        return currentState;
      }
    }
    case "DISCOVERED_PERSON": {
      if (currentState.people.includes(action.email)) {
        return currentState;
      }
      return {
        events: currentState.events,
        ignorePeople: currentState.ignorePeople,
        people: [...currentState.people, action.email],
      };
    }
    default:
      return currentState;
  }
}

async function digestMessage(message: string) {
  const msgUint8 = new TextEncoder().encode(message); // encode as (utf-8) Uint8Array
  const hashBuffer = await window.crypto.subtle.digest("SHA-256", msgUint8); // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join(""); // convert bytes to hex string
  return hashHex;
}

type FetchFn = <T>(...args: Parameters<typeof fetch>) => Promise<T>;

async function fetchHoozinData(
  fetchWithCache: FetchFn,
  dispatch: React.Dispatch<Action>,
  options: { minDate: Temporal.PlainDate; maxDate: Temporal.PlainDate }
) {
  let url = new URL("https://content-people.googleapis.com/v1/people:listDirectoryPeople");
  url.searchParams.set("readMask", "names,emailAddresses,calendarUrls");
  url.searchParams.set("sources", "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("requestSyncToken", "true");

  // TODO: Use sync token
  // if (peopleSyncToken) {
  //   url.searchParams.set("syncToken", peopleSyncToken);
  // }
  const data1: { error: unknown } | { people: GooglePerson[]; nextSyncToken: string } =
    await fetchWithCache(url);

  for (const person of (data1 as { people: GooglePerson[] }).people) {
    const email = person.emailAddresses?.find((e) => e.metadata?.primary)?.value;
    if (!email) {
      continue;
    }

    dispatch({ type: "DISCOVERED_PERSON", email });

    url = new URL(
      `https://content.googleapis.com/calendar/v3/calendars/${encodeURIComponent(email)}/events`
    );
    url.searchParams.set("eventTypes", "workingLocation");
    url.searchParams.set("maxResults", "100");
    url.searchParams.set("orderBy", "updated");
    url.searchParams.set("showDeleted", "false");
    url.searchParams.set("showHiddenInvitations", "false");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set(
      "timeMin",
      options.minDate.toPlainDateTime({ hour: 0, minute: 0, second: 0, millisecond: 0 }).toString({
        fractionalSecondDigits: 0,
      }) + "Z"
    );
    url.searchParams.set(
      "timeMax",
      options.maxDate
        .add({ days: 1 })
        .toPlainDateTime({ hour: 0, minute: 0, second: 0, millisecond: 0 })
        .toString({
          fractionalSecondDigits: 0,
        }) + "Z"
    );
    url.searchParams.set("timeZone", "Europe/Oslo");

    const data: { items: GoogleCalendarEvent[] } = await fetchWithCache(url);
    for (const calendarEvent of data.items) {
      dispatch({ type: "ADD_PERSON_EVENT", email, calendarEvent });
    }
  }
}

type RoomInformation = {
  name: string;
  events: {
    start: Temporal.PlainDateTime;
    end: Temporal.PlainDateTime;
    title: string;
  }[];
  maxAttendance?: number;
};

async function fetchWazzupData(fetchWithCache: FetchFn): Promise<RoomInformation[]> {
  let url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
  url.searchParams.set("minAccessRole", "reader");
  const data: {
    items: {
      id: string;
      summary: string;
    }[];
  } = await fetchWithCache(url);

  const rooms: RoomInformation[] = [];
  for (const calendar of data.items) {
    const events: RoomInformation["events"] = [];
    // Check if part of resource.google.com domain
    if (!calendar.id.endsWith("@resource.calendar.google.com")) {
      continue;
    }
    url = new URL(
      `https://content.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
        calendar.id
      )}/events`
    );
    url.searchParams.set("eventTypes", "default");
    url.searchParams.set("maxResults", "10");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("showDeleted", "false");
    url.searchParams.set("showHiddenInvitations", "false");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set(
      "timeMax",
      Temporal.Now.plainDateTimeISO().add({ weeks: 1 }).toString() + "Z"
    );
    url.searchParams.set(
      "timeMin",
      Temporal.Now.plainDateTimeISO()
        .with({
          minute: 0,
          second: 0,
          millisecond: 0,
        })
        .toString({
          fractionalSecondDigits: 0,
        }) + "Z"
    );

    const response: { items: (GoogleCalendarEvent & { eventType: "default" })[] } =
      await fetchWithCache(url);
    console.log("Events for calendar", calendar.summary, response.items);
    for (const event of response.items) {
      events.push({
        start: Temporal.PlainDateTime.from(event.start.dateTime),
        end: Temporal.PlainDateTime.from(event.end.dateTime),
        title: event.summary,
      });
    }
    let name = calendar.summary;

    // Check if name has parenthesis with a number
    const match = name.match(/\((\d+)\)$/);
    let maxAttendance: number | undefined;
    if (match) {
      maxAttendance = parseInt(match[1], 10);
      name = name.replace(/\(\d+\)$/, "").trim();
    }

    if (maxAttendance) {
      rooms.push({ name, events, maxAttendance });
    } else {
      rooms.push({ name, events });
    }
  }
  console.log("Wazzup data", data);

  // If the rooms share a prefix, remove the prefix
  const roomNames = rooms.map((room) => room.name);
  if (roomNames.length > 1) {
    let prefix = roomNames[0];
    for (const name of roomNames.slice(1)) {
      let i = 0;
      while (i < prefix.length && i < name.length && prefix[i] === name[i]) {
        i++;
      }
      prefix = prefix.slice(0, i);
      if (!prefix) {
        break;
      }
    }
    if (prefix) {
      // Remove trailing non-alphanumeric characters
      prefix = prefix.replace(/[^a-zA-Z0-9-]+$/, "");
      if (prefix.length >= 3) {
        for (const room of rooms) {
          if (room.name.startsWith(prefix)) {
            room.name = room.name.slice(prefix.length).trim();
          }
        }
      }
    }
  }
  return rooms;
}

type TGoogleTokenContext = {
  fetch: FetchFn;
};

const GoogleTokenContext = createContext<TGoogleTokenContext>({ fetch } as TGoogleTokenContext);

function useGoogleToken() {
  return useContext(GoogleTokenContext);
}

function GoogleTokenProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<TokenResponse | null>(() => {
    const oldValue = localStorage.getItem("googleToken");
    return oldValue ? JSON.parse(oldValue) : null;
  });

  const fetchWithCache = useCallback(
    async function fetchWithCache(url: URL | RequestInfo, options?: RequestInit) {
      const cacheKey = await digestMessage(url.toString() + "V1");
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
      const response = await fetch(url, {
        ...options,
        headers: { ...options?.headers, Authorization: `Bearer ${token?.access_token}` },
      });
      const data = await response.json();
      try {
        if (response.status === 401) {
          // Token expired or invalid
          setToken(null);
          localStorage.removeItem("googleToken");
          throw new Error("Unauthorized, please sign in again");
        }
        if (response.status == 200) {
          localStorage.setItem(cacheKey, JSON.stringify(data));
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "QuotaExceededError") {
          // Clear the entire cache if we exceed quota
          console.warn("Cleared cache due to quota exceeded");
          localStorage.clear();
        }
      }
      return data;
    },
    [token, setToken]
  );

  const handleGoogleAuth = useCallback(
    async function handleGoogleAuth() {
      const token = await new Promise<TokenResponse>((resolve) => {
        // @ts-expect-error missing types
        const tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID,
          scope:
            "profile https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/directory.readonly",
          callback: (tokenResponse: TokenResponse) => {
            console.log("Token Response", tokenResponse);
            resolve(tokenResponse);
          },
        });
        tokenClient.requestAccessToken();
      });

      localStorage.setItem("googleToken", JSON.stringify(token));
      setToken(token);
    },
    [setToken]
  );

  if (!token) {
    return <button onClick={handleGoogleAuth}>Sign in with Google</button>;
  }
  return (
    <GoogleTokenContext.Provider value={{ fetch: fetchWithCache }}>
      {children}
    </GoogleTokenContext.Provider>
  );
}

function Avatar({ email, tooltip }: { email: string; tooltip: string }) {
  const [hash, setHash] = useState<string | null>(null);

  useEffect(() => {
    if (hash) return;
    digestMessage(email.trim().toLowerCase()).then(setHash);
  }, [hash, email]);

  const initials = email.split("@")[0].toUpperCase();

  return (
    <div
      style={{
        background: "#eee",
        borderRadius: 6,
        width: 32,
        height: 32,
        overflow: "hidden",
        color: "#111",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundImage: hash
          ? `url(https://gravatar.com/avatar/${hash}?d=initials&initials=${initials}&s=64)`
          : undefined,
        backgroundSize: "cover",
      }}
      title={tooltip}
    />
  );
}
function humanDate(date: Temporal.PlainDate): string {
  if (Temporal.PlainDate.compare(date, Temporal.Now.plainDateISO()) === 0) {
    return "Today";
  } else if (Temporal.PlainDate.compare(date, Temporal.Now.plainDateISO().add({ days: 1 })) === 0) {
    return "Tomorrow";
  }
  // Use the name of the day of the week if less than 7 days away
  else if (Temporal.PlainDate.compare(date, Temporal.Now.plainDateISO().add({ days: 7 })) < 0) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return dayNames[date.dayOfWeek % 7];
  }

  return date.toString();
}

function DateSummary({
  date,
  state,
  showLegend,
  opacity = 1,
}: {
  date: Temporal.PlainDate;
  state: State;
  showLegend: boolean;
  opacity?: number;
}) {
  const entriesForDate = state.events.filter((entry) => entry.date === date.toString());
  const seenEmails = entriesForDate.map((entry) => entry.personEmail);
  const missingPeople = state.people.filter((email) => !seenEmails.includes(email));

  const byStatus: Record<string, string[]> = {
    officeLocation: [],
    homeOffice: [],
  };
  for (const entry of entriesForDate) {
    if (!byStatus[entry.status]) {
      byStatus[entry.status] = [];
    }
    byStatus[entry.status].push(entry.personEmail);
  }
  for (const email of missingPeople) {
    if (!byStatus["unknown"]) {
      byStatus["unknown"] = [];
    }
    byStatus["unknown"].push(email);
  }

  const title = humanDate(date);

  return (
    <div style={{ opacity }}>
      {showLegend ? (
        <div
          style={{
            display: "grid",
            alignItems: "flex-end",
            gridTemplateColumns: "2fr 1fr 2fr",
            gap: "2em",
          }}
        >
          <h2
            style={{
              opacity: 0.4,
              textTransform: "uppercase",
              textAlign: "right",
              fontSize: "1rem",
              fontWeight: "800",
            }}
          >
            Office
          </h2>
          <h2 style={{ textAlign: "center" }}>{title}</h2>
          <h2
            style={{
              opacity: 0.4,
              textTransform: "uppercase",
              textAlign: "left",
              fontSize: "1rem",
              fontWeight: "800",
            }}
          >
            Remote
          </h2>
        </div>
      ) : (
        <h2>{title}</h2>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr 2fr",
          gap: "2em",
          alignItems: "center",
        }}
      >
        <div
          style={{ display: "flex", flexDirection: "row-reverse", flexWrap: "wrap", gap: "0.5em" }}
        >
          {byStatus["homeOffice"].map((email) => {
            return <Avatar key={email} email={email} tooltip={`${email} working from home`} />;
          })}
        </div>
        <div>
          {byStatus["unknown"]?.length && (
            <>
              <span style={{ fontSize: "1.25rem", fontFeatureSettings: "'tnum'" }}>
                {byStatus["unknown"].length}
              </span>
              <br />
              TBD
            </>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "0.5em" }}>
          {byStatus["officeLocation"].map((email) => {
            return <Avatar key={email} email={email} tooltip={`${email} is in the office`} />;
          })}
        </div>
      </div>
    </div>
  );
}

function workingDate(date: Temporal.PlainDate = Temporal.Now.plainDateISO()) {
  let nextDay = date;
  if (nextDay.dayOfWeek === 6) {
    // Saturday, skip to Monday
    nextDay = nextDay.add({ days: 2 });
  } else if (nextDay.dayOfWeek === 0) {
    // Sunday, skip to Monday
    nextDay = nextDay.add({ days: 1 });
  }
  return nextDay;
}

const useDevlog =
  import.meta.env.MODE === "development"
    ? function useDevlog<T>(state: T) {
        useEffect(() => {
          const timeout = setTimeout(() => {}, 500);

          return () => {
            clearTimeout(timeout);
          };
        }, [state]);
      }
    : function noop() {};

function Hoozin() {
  const { fetch } = useGoogleToken();
  const [state, dispatch] = useReducer(stateReducer, {
    events: [],
    ignorePeople: [],
    people: [],
  });

  const days = useMemo(() => {
    const days: Temporal.PlainDate[] = [workingDate()];
    while (days.length < 5) {
      days.unshift(workingDate(days[0].add({ days: 1 })));
    }
    days.reverse();

    return days;
  }, []);

  useEffect(() => {
    if (days.length === 0) return;
    fetchHoozinData(fetch, dispatch, { minDate: days[0], maxDate: days[days.length - 1] });
  }, [days, fetch, dispatch]);

  useDevlog(state);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr",
        gap: "3em",
        width: "min(32rem, calc(100vw - 64px))",
        paddingTop: "5rem",
      }}
    >
      {days.map((date, index) => (
        <DateSummary
          key={date.toString()}
          date={date}
          state={state}
          showLegend={index === 0}
          opacity={(6 - index) / 6}
        />
      ))}
    </div>
  );
}

function Wazzap() {
  const { fetch } = useGoogleToken();

  const [rooms, setRooms] = useState<RoomInformation[]>([]);

  useEffect(() => {
    fetchWazzupData(fetch).then((data) => {
      console.log("Wazzup data", data);
      setRooms(data);
    });
  }, [fetch]);

  return (
    <div>
      <div className="room-list">
        {rooms.length === 0 ? (
          <div style={{ gridColumn: "1 / span 2" }}>Loading...</div>
        ) : (
          rooms.map((room) => {
            const [nextEvent, secondEvent] = room.events;

            let roomDetails = (
              <>
                {nextEvent ? (
                  <div>
                    <strong>Next:</strong> {nextEvent.title}{" "}
                    {nextEvent.start.toLocaleString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    -{" "}
                    {nextEvent.end.toLocaleString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                ) : (
                  <div>No upcoming events</div>
                )}
                {secondEvent && (
                  <div style={{ color: "#666" }}>
                    <strong>Then:</strong> {secondEvent.title}{" "}
                    {secondEvent.start.toLocaleString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    -{" "}
                    {secondEvent.end.toLocaleString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                )}
              </>
            );
            if (nextEvent.start.toPlainDate().equals(Temporal.Now.plainDateISO()) === false) {
              roomDetails = (
                <div>
                  <span style={{ fontSize: "1.25rem" }}>No more events today</span>
                  {nextEvent && (
                    <div style={{ color: "#999" }}>
                      <strong>
                        {humanDate(nextEvent.start.toPlainDate())} at{" "}
                        {nextEvent.start.toLocaleString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        :
                      </strong>{" "}
                      {nextEvent.title}{" "}
                    </div>
                  )}
                </div>
              );
            }

            return (
              <div key={room.name} style={{ marginBottom: "2em", textAlign: "left" }}>
                <h2 style={{ marginBottom: 0 }}>{room.name}</h2>
                <div
                  style={{
                    textTransform: "uppercase",
                    color: "#777",
                    fontWeight: "bold",
                    marginTop: 0,
                    marginBottom: "0.5em",
                  }}
                >
                  Fits {room.maxAttendance} people
                </div>
                {roomDetails}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function resolveInitialActive(): "hoozin" | "wazzap" {
  const hash = window.location.hash.slice(1).toLowerCase();
  if (hash === "wazzap") {
    return "wazzap";
  }
  return "hoozin";
}

function InnerApp() {
  const [active, setActive] = useState<"hoozin" | "wazzap">(resolveInitialActive());

  if (active === "wazzap") {
    return (
      <div className="App">
        <div
          style={{
            position: "fixed",
            top: "1rem",
            left: "1rem",
            display: "flex",
          }}
        >
          <a
            key="switch-hoozin"
            href="#hoozin"
            onClick={() => {
              setActive("hoozin");
            }}
          >
            Hoozin
          </a>
          <a
            key="switch-wazzap"
            href="#wazzap"
            className="active"
            onClick={() => {
              setActive("wazzap");
            }}
          >
            Wazzap
          </a>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: "2rem",
            width: "min(32rem, calc(100vw - 64px))",
          }}
        >
          <Wazzap />
        </div>
      </div>
    );
  }

  return (
    <div className="App">
      <div style={{ position: "fixed", top: "1rem", left: "1rem", display: "flex" }}>
        <a
          key="switch-hoozin"
          href="#hoozin"
          className="active"
          onClick={() => {
            setActive("hoozin");
            return true;
          }}
        >
          Hoozin
        </a>
        <a
          key="switch-wazzap"
          href="#wazzap"
          onClick={() => {
            setActive("wazzap");
            return true;
          }}
        >
          Wazzap
        </a>
      </div>
      <Hoozin />
    </div>
  );
}

function App() {
  return (
    <>
      <GoogleTokenProvider>
        <InnerApp />
      </GoogleTokenProvider>
    </>
  );
}

export default App;
