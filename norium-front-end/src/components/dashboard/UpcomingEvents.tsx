import {
  CalendarDays,
  Clock3,
  MapPin,
} from "lucide-react";

const events = [
  {
    title: "Reunião com cliente",
    date: "Hoje",
    time: "14:00",
    location: "Google Meet",
  },
  {
    title: "Sprint Planning",
    date: "Amanhã",
    time: "09:30",
    location: "Sala Alpha",
  },
  {
    title: "Apresentação do projeto",
    date: "26 Jun",
    time: "16:00",
    location: "Microsoft Teams",
  },
];

export default function UpcomingEvents() {
  return (
    <section
      className="
        rounded-3xl
        border
        border-[var(--border)]
        bg-[var(--surface)]
        p-6
        shadow-sm
      "
    >
      <div className="mb-6 flex items-center gap-3">

        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-500">
          <CalendarDays size={22} />
        </div>

        <div>

          <h2 className="text-xl font-bold text-[var(--text)]">
            Próximos eventos
          </h2>

          <p className="text-sm text-[var(--text-secondary)]">
            Agenda das próximas horas.
          </p>

        </div>

      </div>

      <div className="space-y-4">

        {events.map((event) => (

          <div
            key={event.title}
            className="
              rounded-2xl
              border
              border-[var(--border)]
              p-4
              transition-all
              duration-300
              hover:border-blue-500
              hover:shadow-md
            "
          >

            <h3 className="font-semibold text-[var(--text)]">
              {event.title}
            </h3>

            <div className="mt-3 flex items-center gap-2 text-sm text-[var(--text-secondary)]">

              <Clock3 size={15} />

              {event.date} • {event.time}

            </div>

            <div className="mt-2 flex items-center gap-2 text-sm text-[var(--text-secondary)]">

              <MapPin size={15} />

              {event.location}

            </div>

          </div>

        ))}

      </div>
    </section>
  );
}
