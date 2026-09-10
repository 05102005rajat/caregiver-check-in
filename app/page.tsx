import Link from "next/link";

export default function Home() {
  return (
    <div className="max-w-lg mx-auto mt-24 text-center space-y-6">
      <h1 className="text-2xl font-semibold">Caregiver Check-In</h1>
      <p className="text-gray-600">
        Set up daily check-in calls for a parent or loved one. We&apos;ll call
        them at the right times, confirm meds and appointments, and text you
        only if something needs your attention.
      </p>
      <Link
        href="/setup"
        className="inline-block bg-black text-white rounded px-4 py-2"
      >
        Set up check-ins
      </Link>
    </div>
  );
}
