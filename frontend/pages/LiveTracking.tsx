import { Card } from "antd";

export default function LiveTracking() {
  return (
    <Card title="Live Tracking">
      <div
        style={{
          height: 500,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          background: "#f5f5f5",
          fontSize: 24,
        }}
      >
        🗺️ Map will be displayed here
      </div>
    </Card>
  );
}