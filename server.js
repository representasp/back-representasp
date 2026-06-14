const express = require('express');
const axios = require('axios');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const CONSTANTS = {
    SUB_KEY: 'd701a2043aa24d7ebb37e9adf60d043b',
    PRODUCT: 'SalaDoFuturo',
    BASE_SED: 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi',
    BASE_IPTV: 'https://edusp-api.ip.tv'
};

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    try {
        // 1. LOGIN SED
        const loginRes = await axios.post(`${CONSTANTS.BASE_SED}/credenciais/api/LoginCompletoToken`,
            { user, senha },
            { headers: {
                'Content-Type': 'application/json',
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }}
        );

        const tokenSed = loginRes.data.token;
        const dadosUsuario = loginRes.data.DadosUsuario || {};
        const cdUsuario9 = dadosUsuario.CD_USUARIO?.toString();
        const cdUsuario8 = cdUsuario9 ? cdUsuario9.substring(0, 8) : '';
        const nomeCompletoAluno = dadosUsuario.NAME || 'Estudante';

        // Captura e formatação dos cookies de afinidade do gateway
        const cookiesRecebidos = loginRes.headers['set-cookie'] || [];
        const cookiesFiltrados = cookiesRecebidos.map(cookie => cookie.split(';')[0]).join('; ');

        const sedConfig = {
            headers: {
                'Authorization': `Bearer ${tokenSed}`,
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'Cookie': cookiesFiltrados,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://saladofuturo.educacao.sp.gov.br',
                'Referer': 'https://saladofuturo.educacao.sp.gov.br/'
            }
        };

        // 2. BUSCAR TURMA
        let infoTurma = {};
        try {
            const turmaRes = await axios.get(
                `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`, 
                sedConfig
            );
            if (Array.isArray(turmaRes.data)) {
                infoTurma = turmaRes.data[0];
            } else if (turmaRes.data?.data) {
                infoTurma = Array.isArray(turmaRes.data.data) ? turmaRes.data.data[0] : turmaRes.data.data;
            }
        } catch (errTurma) {
            console.error(`[BFF] Erro na rota de Turma: ${errTurma.message}`);
        }

        // 3. HANDSHAKE IP.TV
        let authTokenIptv = null;
        try {
            const iptvHandshake = await axios.post(`${CONSTANTS.BASE_IPTV}/registration/edusp/token`,
                { token: tokenSed },
                {
                    httpsAgent,
                    headers: {
                        'Host': 'edusp',
                        'x-api-realm': 'edusp',
                        'x-api-platform': 'webclient',
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                }
            );
            authTokenIptv = iptvHandshake.data?.auth_token;
        } catch (errIptv) {
            console.error(`[BFF] Erro no Handshake IPTV: ${errIptv.message}`);
        }

        // 4. BUSCAR AVALIAÇÕES
        let totalAvaliacoes = 0;
        try {
            const avalRes = await axios.get(`${CONSTANTS.BASE_SED}/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${cdUsuario8}&AnoLetivo=2026`, sedConfig);
            const listaAvaliacoes = Array.isArray(avalRes.data) ? avalRes.data : (avalRes.data.data || []);
            totalAvaliacoes = listaAvaliacoes.length;
        } catch (errAval) {
            console.error(`[BFF] Erro na rota de avaliações: ${errAval.message}`);
        }

        // 5. BUSCAR TAREFAS NA IP.TV (Modo de Varredura Amplo)
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;
        
        if (authTokenIptv) {
            try {
                // Chamada estendida trazendo os alvos de publicação para capturar tarefas reais da CMSP
                const tasksRes = await axios.get(`${CONSTANTS.BASE_IPTV}/tms/task/todo/count?filter_expired=true&publication_target=vialv&user_id=${cdUsuario9}`, {
                    httpsAgent,
                    headers: { 
                        'x-api-key': authTokenIptv, 
                        'Host': 'edusp',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                
                // Mapeia de forma agressiva checando múltiplos nós de retorno possíveis da API
                tarefasPendentes = tasksRes.data?.todo ?? tasksRes.data?.count ?? tasksRes.data?.data?.todo ?? 0;
                tarefasExpiradas = tasksRes.data?.expired ?? tasksRes.data?.data?.expired ?? 0;
            } catch (errTasks) {
                console.error(`[BFF] Erro ao processar contadores IP.TV: ${errTasks.message}`);
            }
        }

        // 6. MAPEAR REDAÇÕES (Simulação baseada no histórico de notas da SED)
        // Como a API de redação possui token próprio e isolado, extraímos o indicador de pendências padrão
        let totalRedacoes = 0; 
        try {
            // Chamada opcional preventiva para validar se há redações pendentes no barramento de boletim
            const redacaoRes = await axios.get(`${CONSTANTS.BASE_SED}/apiboletim/api/Redacao/GetRedacoesAluno?AlunoId=${cdUsuario8}`, sedConfig);
            totalRedacoes = Array.isArray(redacaoRes.data) ? redacaoRes.data.length : (redacaoRes.data?.data?.length || 0);
        } catch (e) {
            // Fallback: Caso a rota de redação mude, não quebra o fluxo principal
            totalRedacoes = 0;
        }

        // RETORNO COMPLETO PARA O FRONTEND
        res.json({
            aluno: {
                nome: nomeCompletoAluno,
                codigo: cdUsuario8,
                escola: infoTurma.NomeEscola || 'Não Informada',
                turma: infoTurma.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: tarefasPendentes,
                expiradas: tarefasExpiradas,
                avaliacoes: totalAvaliacoes,
                redacoes: totalRedacoes
            }
        });

    } catch (error) {
        console.error(`[BFF] Erro Crítico Executivo: ${error.message}`);
        res.status(error.response ? error.response.status : 500).json({
            error: "Erro de processamento no barramento de dados centralizado.",
            details: error.message
        });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF robusto e corrigido rodando na porta ${PORT}`));
