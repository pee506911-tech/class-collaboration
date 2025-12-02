use serde::Serialize;

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn success(data: T) -> Self {
        Self {
            success: true,
            data,
            error: None,
        }
    }

    pub fn error(message: String, data: T) -> Self {
        Self {
            success: false,
            data,
            error: Some(message),
        }
    }
}
