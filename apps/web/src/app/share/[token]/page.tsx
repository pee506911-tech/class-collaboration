import SharedSessionClient from "./SharedSessionClient";

export const runtime = 'edge';

export default async function SharedSessionPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    return <SharedSessionClient token={token} />;
}
