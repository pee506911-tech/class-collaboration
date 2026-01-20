import SharedSessionClient from "./SharedSessionClient";

export const runtime = 'edge';

export default function SharedSessionPage({ params }: { params: { token: string } }) {
    return <SharedSessionClient token={params.token} />;
}
